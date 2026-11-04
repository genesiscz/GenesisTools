import { mobileAppiumStartCommand, mobileBuildCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { appiumPortFor, appiumReady, startAppium } from "./appium";
import {
    appInstalled,
    developerDir,
    listSimulators,
    type SimDevice,
    simulatorUiClient,
    simulatorUiRunning,
    wdaPortsFor,
} from "./simulator";
import { AppiumSession } from "./webdriver";

/**
 * The simulator a command works on. An explicit udid wins; otherwise exactly one booted simulator must exist, because
 * picking one of several would drive (and maybe reboot) a simulator another session is using.
 */
export async function pickSimulator(udid?: string, options: { booted?: boolean } = {}): Promise<SimDevice> {
    const devices = await listSimulators();

    if (udid) {
        const device = devices.find((candidate) => candidate.udid === udid);

        if (!device) {
            throw new Error(`no simulator with udid ${udid}; list them with: xcrun simctl list devices`);
        }

        if (options.booted !== false && device.state !== "Booted") {
            throw new Error(
                `simulator ${device.name} (${udid}) is ${device.state}; boot it: xcrun simctl boot ${udid}`
            );
        }

        return device;
    }

    const booted = devices.filter((device) => device.state === "Booted");

    if (booted.length === 1) {
        return booted[0];
    }

    if (booted.length === 0) {
        throw new Error("no simulator is booted; boot one (xcrun simctl boot <udid>) or pass --udid");
    }

    const names = booted.map((device) => `${device.name} ${device.udid}`).join(", ");
    throw new Error(`${booted.length} simulators are booted (${names}); pass --udid so another session's is not used`);
}

/** Whether this Xcode's simulator UI is DeviceHub (Xcode 27 on), which an old XCUITest driver cannot run with. */
export async function usesDeviceHub(): Promise<boolean> {
    return simulatorUiClient(await developerDir())?.name === "DeviceHub";
}

export async function requireAppInstalled(udid: string, bundleId: string): Promise<void> {
    if (!(await appInstalled(udid, bundleId))) {
        throw new Error(`${bundleId} is not installed on ${udid}; build it first: ${mobileBuildCommand()}`);
    }
}

/**
 * The Appium port a command uses for a simulator: the one asked for, else the simulator's own (`appiumPortFor`). With
 * `start`, a port with no server gets one this tool owns; otherwise a missing server is an error with the fix.
 */
export async function ensureAppium(options: { udid: string; port?: number; start?: boolean }): Promise<number> {
    const port = options.port ?? appiumPortFor(options.udid);

    if (await appiumReady(port)) {
        return port;
    }

    if (options.start === false) {
        throw new Error(`no Appium on :${port}; start one: ${mobileAppiumStartCommand(options.udid)}`);
    }

    await startAppium({ port, usesDeviceHub: await usesDeviceHub() });
    return port;
}

/**
 * The XCUITest capabilities for driving an app that is already installed, without reinstalling or relaunching it:
 * `noReset`, no auto launch, and `shouldTerminateApp: false` so closing the session leaves the app on screen. The WDA
 * port is the simulator's own, so two agents on two simulators never kill each other's WDA, and `isHeadless` matches
 * whether a simulator UI is open (a wrong value reboots the simulator on Xcode 27).
 */
export async function attachCapabilities(options: {
    udid: string;
    bundleId: string;
    launch?: boolean;
}): Promise<Record<string, unknown>> {
    const ports = wdaPortsFor(options.udid);
    return {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:udid": options.udid,
        "appium:bundleId": options.bundleId,
        "appium:noReset": true,
        "appium:autoLaunch": options.launch ?? true,
        "appium:forceAppLaunch": false,
        "appium:shouldTerminateApp": false,
        "appium:waitForQuiescence": false,
        "appium:wdaLocalPort": ports.wda,
        "appium:mjpegServerPort": ports.mjpeg,
        "appium:isHeadless": !(await simulatorUiRunning()),
        "appium:newCommandTimeout": 240,
        "appium:wdaLaunchTimeout": 120_000,
        "appium:wdaConnectionTimeout": 120_000,
        // Some driver versions default to JPEG quality 1 for screenshots.
        "appium:screenshotQuality": 0,
    };
}

export async function attachSession(options: {
    udid: string;
    bundleId: string;
    appiumPort: number;
    launch?: boolean;
}): Promise<AppiumSession> {
    return AppiumSession.create({ port: options.appiumPort, capabilities: await attachCapabilities(options) });
}
