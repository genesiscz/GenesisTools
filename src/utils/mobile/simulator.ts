import { existsSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type BoundedCommandResult, boundedCommand } from "@genesiscz/utils/process/bounded-command";

/**
 * iOS simulator control through `xcrun simctl`, which is unchanged on Xcode 27. What changed there is the UI client:
 * Simulator.app is gone and DeviceHub.app (`com.apple.dt.Devices`) took its place, so anything that looks the
 * simulator app up by name or by `com.apple.iphonesimulator` (Expo's `run:ios`, old Appium XCUITest drivers) fails.
 * A booted device runs headless with no UI client at all.
 */

const log = logger.child({ component: "mobile.simulator" });

export interface SimDevice {
    udid: string;
    name: string;
    /** `Booted`, `Shutdown`, … as simctl reports it. */
    state: string;
    /** The runtime id, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-5`. */
    runtime: string;
    /** The runtime as a version, e.g. `26.5`; empty for a runtime id this cannot read. */
    osVersion: string;
    isAvailable: boolean;
}

interface SimctlDeviceList {
    devices: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>>;
}

async function simctl(args: string[], timeoutMs = 60_000): Promise<BoundedCommandResult> {
    const command = ["xcrun", "simctl", ...args];
    const result = await boundedCommand({ command, timeoutMs });
    log.debug({ command: command.join(" "), status: result.status, stderr: result.stderr.trim() }, "simctl");
    return result;
}

async function simctlOrThrow(args: string[], timeoutMs?: number): Promise<string> {
    const result = await simctl(args, timeoutMs);

    if (result.status !== 0) {
        const reason = result.stderr.trim() || result.error?.message || `exit ${result.status ?? result.signal}`;
        throw new Error(`xcrun simctl ${args[0]} failed: ${reason}`);
    }

    return result.stdout;
}

export function runtimeVersion(runtime: string): string {
    const match = runtime.match(/iOS-(\d+)-(\d+)/);
    return match ? `${match[1]}.${match[2]}` : "";
}

export async function listSimulators(): Promise<SimDevice[]> {
    const stdout = await simctlOrThrow(["list", "devices", "-j"]);
    const parsed = SafeJSON.parse(stdout, { strict: true }) as SimctlDeviceList;

    return Object.entries(parsed.devices).flatMap(([runtime, devices]) =>
        devices.map((device) => ({
            udid: device.udid,
            name: device.name,
            state: device.state,
            runtime,
            osVersion: runtimeVersion(runtime),
            isAvailable: device.isAvailable !== false,
        }))
    );
}

export async function installApp(udid: string, appPath: string): Promise<void> {
    await simctlOrThrow(["install", udid, appPath], 300_000);
}

export async function launchApp(udid: string, bundleId: string): Promise<void> {
    await simctlOrThrow(["launch", udid, bundleId]);
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
    // A terminate of an app that is not running exits non-zero; that is the state we wanted.
    await simctl(["terminate", udid, bundleId]);
}

export async function openUrl(udid: string, url: string): Promise<void> {
    await simctlOrThrow(["openurl", udid, url]);
}

export async function screenshot(udid: string, file: string): Promise<void> {
    await simctlOrThrow(["io", udid, "screenshot", "--type=png", file]);
}

export async function appInstalled(udid: string, bundleId: string): Promise<boolean> {
    const result = await simctl(["get_app_container", udid, bundleId]);
    return result.status === 0;
}

/**
 * The WebDriverAgent ports for one simulator. Before a session XCUITest kills every WDA on its `wdaLocalPort` that
 * belongs to another simulator, and the default 8100 is shared, so two agents on two simulators kill each other.
 * An FNV-1a hash of the udid picks one of 900 slots, stable per udid.
 */
export function wdaPortsFor(udid: string): { wda: number; mjpeg: number } {
    let hash = 0x811c9dc5;
    for (const char of udid) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    }

    const slot = hash % 900;
    return { wda: 18100 + slot, mjpeg: 19100 + slot };
}

export interface SimulatorUiClient {
    name: "Simulator" | "DeviceHub";
    path: string;
}

/** The simulator UI app this Xcode ships: Simulator.app before Xcode 27, DeviceHub.app from Xcode 27 on. */
export function simulatorUiClient(developerDir: string): SimulatorUiClient | null {
    const xcodeApp = developerDir.replace(/\/Contents\/Developer\/?$/, "");
    const candidates: SimulatorUiClient[] = [
        { name: "Simulator", path: `${developerDir}/Applications/Simulator.app` },
        { name: "DeviceHub", path: `${xcodeApp}/Contents/Applications/DeviceHub.app` },
    ];

    return candidates.find((candidate) => existsSync(candidate.path)) ?? null;
}

/**
 * Whether a simulator UI is open. Appium's `isHeadless` must match it: a wrong value makes the driver reboot the
 * simulator to show it, or kill the open UI.
 */
export async function simulatorUiRunning(): Promise<boolean> {
    const result = await boundedCommand({
        command: ["pgrep", "-f", "(Simulator|DeviceHub)\\.app/Contents/MacOS/"],
        timeoutMs: 5_000,
    });
    return result.status === 0;
}

export async function developerDir(): Promise<string> {
    const result = await boundedCommand({ command: ["xcode-select", "-p"], timeoutMs: 5_000 });

    if (result.status !== 0) {
        throw new Error(`xcode-select -p failed: ${result.stderr.trim() || "no developer directory"}`);
    }

    return result.stdout.trim();
}
