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
    const slot = udidSlot(udid, 900);
    return { wda: 18100 + slot, mjpeg: 19100 + slot };
}

/** A stable slot in `[0, slots)` for a udid: an FNV-1a hash, so every tool that derives a port agrees on it. */
export function udidSlot(udid: string, slots: number): number {
    let hash = 0x811c9dc5;
    for (const char of udid) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    }

    return hash % slots;
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

export interface SimDeviceType {
    identifier: string;
    name: string;
    productFamily: string;
    bundlePath: string;
    /** The hardware id, e.g. `iPhone18,1`; a higher first number is a newer model. */
    modelIdentifier?: string;
}

export interface SimRuntime {
    identifier: string;
    version: string;
    platform: string;
    isAvailable: boolean;
    supportedDeviceTypes: string[];
}

/** A device type's main screen in points (pixels over scale). */
export interface SimScreen {
    width: number;
    height: number;
    scale: number;
}

export async function listDeviceTypes(): Promise<SimDeviceType[]> {
    const stdout = await simctlOrThrow(["list", "devicetypes", "-j"]);
    const parsed = SafeJSON.parse(stdout, { strict: true }) as { devicetypes: SimDeviceType[] };
    return parsed.devicetypes;
}

export async function listRuntimes(): Promise<SimRuntime[]> {
    const stdout = await simctlOrThrow(["list", "runtimes", "-j"]);
    const parsed = SafeJSON.parse(stdout, { strict: true }) as {
        runtimes: Array<{
            identifier: string;
            version: string;
            platform?: string;
            isAvailable?: boolean;
            supportedDeviceTypes?: Array<{ identifier: string }>;
        }>;
    };

    return parsed.runtimes.map((runtime) => ({
        identifier: runtime.identifier,
        version: runtime.version,
        platform: runtime.platform ?? (runtime.identifier.includes(".iOS-") ? "iOS" : ""),
        isAvailable: runtime.isAvailable !== false,
        supportedDeviceTypes: (runtime.supportedDeviceTypes ?? []).map((type) => type.identifier),
    }));
}

async function plistJson(path: string): Promise<unknown> {
    const result = await boundedCommand({ command: ["plutil", "-convert", "json", "-o", "-", path], timeoutMs: 5_000 });

    if (result.status !== 0) {
        log.debug({ path, stderr: result.stderr.trim() }, "plutil could not read the plist");
        return null;
    }

    return SafeJSON.parse(result.stdout, { strict: true });
}

/**
 * The screen of a device type, read from its bundle: Xcode 27 keeps it in `capabilities.plist`
 * (`ScreenDimensionsCapability.main-screen-*`), older Xcodes in `profile.plist` (`mainScreenWidth`, …). Null when
 * neither file names it.
 */
export async function deviceTypeScreen(bundlePath: string): Promise<SimScreen | null> {
    const resources = `${bundlePath}/Contents/Resources`;
    const capabilities = (await plistJson(`${resources}/capabilities.plist`)) as {
        capabilities?: { ScreenDimensionsCapability?: Record<string, number> };
    } | null;
    const dims = capabilities?.capabilities?.ScreenDimensionsCapability;

    if (dims?.["main-screen-width"] && dims["main-screen-scale"]) {
        const scale = dims["main-screen-scale"];
        return { width: dims["main-screen-width"] / scale, height: (dims["main-screen-height"] ?? 0) / scale, scale };
    }

    const profile = (await plistJson(`${resources}/profile.plist`)) as Record<string, number> | null;

    if (profile?.mainScreenWidth && profile.mainScreenScale) {
        const scale = profile.mainScreenScale;
        return { width: profile.mainScreenWidth / scale, height: (profile.mainScreenHeight ?? 0) / scale, scale };
    }

    return null;
}

/** Creates a simulator and returns its udid. */
export async function createSimulator(options: { name: string; deviceType: string; runtime: string }): Promise<string> {
    const stdout = await simctlOrThrow(["create", options.name, options.deviceType, options.runtime]);
    return stdout.trim();
}

/**
 * Boots a simulator and waits until it has finished booting (`bootstatus -b` boots a shut-down device itself). It
 * opens no simulator UI: an open DeviceHub flips `isHeadless` for every Appium session on this Mac.
 */
export async function bootSimulator(udid: string, timeoutMs = 300_000): Promise<void> {
    await simctlOrThrow(["bootstatus", udid, "-b"], timeoutMs);
}

export async function shutdownSimulator(udid: string): Promise<void> {
    // A shutdown of a device that is already shut down exits non-zero; that is the state we wanted.
    await simctl(["shutdown", udid], 120_000);
}

export async function deleteSimulator(udid: string): Promise<void> {
    await simctlOrThrow(["delete", udid], 120_000);
}

export async function uninstallApp(udid: string, bundleId: string): Promise<void> {
    await simctlOrThrow(["uninstall", udid, bundleId], 120_000);
}

/**
 * The `simctl privacy` services. iOS has no service for notifications, the camera or the local network; those
 * prompts are answered by the alert watcher (or `idb approve` where idb is installed).
 */
export const SIMCTL_PRIVACY_SERVICES = [
    "calendar",
    "contacts-limited",
    "contacts",
    "location",
    "location-always",
    "photos-add",
    "photos",
    "media-library",
    "microphone",
    "motion",
    "reminders",
    "siri",
] as const;

export type SimctlPrivacyService = (typeof SIMCTL_PRIVACY_SERVICES)[number];

/**
 * Grants, revokes or resets one privacy service for an app. Bounded at 8 s: on some iOS 26.5 simulators one grant
 * wedges installd, and an unbounded call would hang the command with it. Returns false on a timeout or a failure.
 */
export async function setPrivacy(options: {
    udid: string;
    action: "grant" | "revoke" | "reset";
    service: SimctlPrivacyService | "all";
    bundleId?: string;
}): Promise<boolean> {
    const args = ["privacy", options.udid, options.action, options.service];

    if (options.bundleId) {
        args.push(options.bundleId);
    }

    const result = await simctl(args, 8_000);

    if (result.status !== 0) {
        log.warn({ ...options, stderr: result.stderr.trim(), error: result.error?.message }, "simctl privacy failed");
        return false;
    }

    return true;
}

/** Writes one user default in an app's domain on the simulator (`defaults write <bundle> <key> <args...>`). */
export async function writeAppDefault(options: {
    udid: string;
    bundleId: string;
    key: string;
    value: string[];
}): Promise<void> {
    await simctlOrThrow(["spawn", options.udid, "defaults", "write", options.bundleId, options.key, ...options.value]);
}

export async function deleteAppDefault(options: { udid: string; bundleId: string; key: string }): Promise<void> {
    // Deleting a key that is not set exits non-zero; that is the state we wanted.
    await simctl(["spawn", options.udid, "defaults", "delete", options.bundleId, options.key]);
}

/** The pid of the app's process on the simulator, from launchd; null when it is not running. */
export async function appPid(udid: string, bundleId: string): Promise<number | null> {
    const result = await simctl(["spawn", udid, "launchctl", "list"], 15_000);

    if (result.status !== 0) {
        return null;
    }

    const line = result.stdout.split("\n").find((row) => row.includes(`UIKitApplication:${bundleId}`));
    const pid = line ? Number.parseInt(line.trim().split(/\s+/)[0], 10) : Number.NaN;
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Adds a root CA to the simulator's keychain; one certificate per PEM file (a multi-cert PEM adds only the first). */
export async function addRootCert(udid: string, pemPath: string): Promise<void> {
    await simctlOrThrow(["keychain", udid, "add-root-cert", pemPath]);
}

export interface InstalledAppInfo {
    displayName: string;
    bundleName: string;
    /** The installed `.app` inside the simulator's data folder. */
    path: string;
}

/** What `simctl appinfo` says about an installed app; null when it is not installed. */
export async function installedAppInfo(udid: string, bundleId: string): Promise<InstalledAppInfo | null> {
    const result = await simctl(["appinfo", udid, bundleId], 15_000);

    if (result.status !== 0 || !result.stdout.includes("Path")) {
        return null;
    }

    const field = (key: string) => result.stdout.match(new RegExp(`\\b${key} = "?([^";\\n]+)"?;`))?.[1] ?? "";
    const bundleName = field("CFBundleName");
    return { displayName: field("CFBundleDisplayName") || bundleName, bundleName, path: field("Path") };
}

/** Empties the simulator's whole keychain (every app's items). An uninstall alone keeps an app's keychain items. */
export async function resetKeychain(udid: string): Promise<void> {
    await simctlOrThrow(["keychain", udid, "reset"]);
}
