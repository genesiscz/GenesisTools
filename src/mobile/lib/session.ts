import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { appiumPortFor, appiumReady, startAppium } from "@genesiscz/utils/mobile/appium";
import { simulatorUiRunning, wdaPortsFor } from "@genesiscz/utils/mobile/simulator";
import { AppiumSession } from "@genesiscz/utils/mobile/webdriver";
import { usesDeviceHub } from "./device";

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
        throw new Error(
            `no Appium on :${port}; start one: ${toolCommand("mobile appium start", "--udid", options.udid)}`
        );
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
