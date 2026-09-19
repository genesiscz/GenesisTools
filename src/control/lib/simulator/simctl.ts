import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { z } from "zod";

const { log } = logger.scoped("control-simulator");

export interface SimDevice {
    udid: string;
    name: string;
    runtime: string;
    state: string;
    booted: boolean;
    deviceType: string;
}

const listSchema = z.object({
    devices: z.record(
        z.string(),
        z.array(
            z
                .object({
                    udid: z.string().min(1),
                    name: z.string().min(1),
                    state: z.string().min(1),
                    deviceTypeIdentifier: z.string().optional(),
                    isAvailable: z.boolean().optional(),
                })
                .passthrough()
        )
    ),
});

function shortRuntime(runtime: string): string {
    return runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, " ");
}

export function parseDeviceList(raw: string): SimDevice[] {
    const parsed = listSchema.safeParse(SafeJSON.parse(raw, { strict: true }));
    if (!parsed.success) {
        throw new Error(`simctl device list did not parse: ${parsed.error.issues[0]?.message}`);
    }
    const devices: SimDevice[] = [];
    for (const [runtime, entries] of Object.entries(parsed.data.devices)) {
        for (const entry of entries) {
            if (entry.isAvailable === false) {
                continue;
            }
            devices.push({
                udid: entry.udid,
                name: entry.name,
                runtime: shortRuntime(runtime),
                state: entry.state,
                booted: entry.state === "Booted",
                deviceType: (entry.deviceTypeIdentifier ?? "").replace("com.apple.CoreSimulator.SimDeviceType.", ""),
            });
        }
    }
    return devices;
}

async function simctl(args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const result = await boundedCommand({
        command: ["xcrun", "simctl", ...args],
        timeoutMs: Math.max(1, Math.floor(options.timeoutMs ?? 30_000)),
        signal: options.signal,
    });
    log.debug({ args, status: result.status }, "simctl");
    return result;
}

export async function listDevices(options: { signal?: AbortSignal } = {}): Promise<SimDevice[]> {
    const result = await simctl(["list", "devices", "--json"], options);
    if (result.status !== 0) {
        throw new Error(`simctl list failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.status}`}`);
    }
    return parseDeviceList(result.stdout);
}

export async function bootedDevices(options: { signal?: AbortSignal } = {}): Promise<SimDevice[]> {
    return (await listDevices(options)).filter((device) => device.booted);
}

/**
 * Picks the device to drive. An explicit udid wins; otherwise exactly one booted simulator is
 * required, because silently choosing between two booted devices would send every later action
 * to a screen the caller never named.
 */
export async function resolveDevice(options: { udid?: string; signal?: AbortSignal }): Promise<SimDevice> {
    const devices = await listDevices({ signal: options.signal });
    if (options.udid) {
        // Names repeat across runtimes, so `--udid "iPhone 17 Pro"` can name several devices.
        // Taking the first match reported "is Shutdown, not Booted" while a booted namesake sat
        // right there. Prefer a booted match, and refuse only when the choice is genuinely
        // ambiguous rather than when it merely looks it.
        const matches = devices.filter((device) => device.udid === options.udid || device.name === options.udid);
        if (matches.length === 0) {
            throw new Error(`No simulator named or identified by "${options.udid}".`);
        }

        const bootedMatches = matches.filter((device) => device.booted);
        if (bootedMatches.length > 1) {
            const named = bootedMatches.map((device) => `${device.name} (${device.udid})`).join(", ");
            throw new Error(`"${options.udid}" names more than one booted simulator: ${named}. Pass an exact udid.`);
        }

        const match = bootedMatches[0];
        if (!match) {
            const first = matches[0];
            throw new Error(`Simulator ${first.name} (${first.udid}) is ${first.state}, not Booted.`);
        }

        return match;
    }
    const booted = devices.filter((device) => device.booted);
    if (booted.length === 0) {
        throw new Error("No booted simulator. Boot one with `xcrun simctl boot <udid>` and open Simulator.app.");
    }
    if (booted.length > 1) {
        throw new Error(
            `${booted.length} booted simulators; name one with --udid: ${booted.map((device) => `${device.name}=${device.udid}`).join(", ")}`
        );
    }
    return booted[0];
}

export interface LaunchResult {
    bundleId: string;
    pid: number;
    /** True when the bundle was already running and this call only brought it forward. */
    alreadyRunning: boolean;
}

/** `simctl launch` on a running app returns its existing pid and foregrounds it. */
export function parseLaunchPid(stdout: string): number | undefined {
    const match = /:\s*(\d+)\s*$/.exec(stdout.trim());
    const pid = match ? Number(match[1]) : Number.NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * The bundle id a `launchctl list` label refers to, or the label itself when it names no app.
 *
 * A simulator labels an app `UIKitApplication:com.acme.app[0x8f31][rb-legacy]`, so a bare
 * equality test against the bundle id matches nothing at all. Matching the whole LINE by
 * substring is the other failure: an extension label carries the app's bundle id as a prefix,
 * so `com.acme.app` returned the extension's pid, which `observeSimulator` then stored as the
 * app identity and `sameScope` compared forever after — a relaunch of the real app went
 * unnoticed while the extension kept running.
 *
 * ⚠️ The `UIKitApplication:` shape is from Apple's documented launchd labelling, not from a
 * live device: no simulator was booted when this was written, so the parsing is pinned by the
 * tests below rather than by an observed `launchctl list`.
 */
export function bundleIdFromLaunchLabel(label: string): string {
    const withoutPrefix = label.startsWith("UIKitApplication:") ? label.slice("UIKitApplication:".length) : label;
    const bracket = withoutPrefix.indexOf("[");
    return bracket === -1 ? withoutPrefix : withoutPrefix.slice(0, bracket);
}

export async function runningPid(options: {
    udid: string;
    bundleId: string;
    signal?: AbortSignal;
}): Promise<number | undefined> {
    const result = await simctl(["spawn", options.udid, "launchctl", "list"], { signal: options.signal });
    if (result.status !== 0) {
        return undefined;
    }
    for (const line of result.stdout.split("\n")) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 3 || bundleIdFromLaunchLabel(columns[columns.length - 1]) !== options.bundleId) {
            continue;
        }

        const pid = Number(columns[0]);
        if (Number.isInteger(pid) && pid > 0) {
            return pid;
        }
    }
    return undefined;
}

/**
 * Launches a bundle id, or foregrounds it when it is already running. The `alreadyRunning` flag
 * is read BEFORE the launch, so a caller can tell a cold start from a bring-to-front.
 */
export async function launchApp(options: {
    udid: string;
    bundleId: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<LaunchResult> {
    const before = await runningPid(options);
    const result = await simctl(["launch", options.udid, options.bundleId], {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
    });
    if (result.status !== 0) {
        throw new Error(
            `simctl launch ${options.bundleId} failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.status}`}`
        );
    }
    const pid = parseLaunchPid(result.stdout) ?? before;
    if (pid === undefined) {
        throw new Error(`simctl launch ${options.bundleId} reported no pid: ${result.stdout.trim().slice(0, 200)}`);
    }
    log.info({ udid: options.udid, bundleId: options.bundleId, pid, alreadyRunning: before !== undefined }, "launched");
    return { bundleId: options.bundleId, pid, alreadyRunning: before !== undefined };
}

export async function terminateApp(options: { udid: string; bundleId: string; signal?: AbortSignal }): Promise<void> {
    const result = await simctl(["terminate", options.udid, options.bundleId], { signal: options.signal });
    if (result.status !== 0) {
        throw new Error(`simctl terminate failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.status}`}`);
    }
}

export async function screenshot(options: { udid: string; path: string; signal?: AbortSignal }): Promise<string> {
    const result = await simctl(["io", options.udid, "screenshot", options.path], { signal: options.signal });
    if (result.status !== 0) {
        throw new Error(`simctl screenshot failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.status}`}`);
    }
    return options.path;
}
