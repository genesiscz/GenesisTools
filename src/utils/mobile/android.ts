import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { type BoundedCommandResult, boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type DetachedService, startDetached, stopDetached } from "./service";

/**
 * Android emulators and devices through `adb` and the SDK's `emulator`, every call with a deadline: a wedged adbd or a
 * hanging `uiautomator dump` keeps an adb call open forever otherwise.
 *
 * "Boot completed" in the emulator's log does not mean adb works. When USB debugging is off in the guest (turning
 * "Use developer options" off does that, and it survives a reboot), adb lists the emulator as `offline` while its
 * console still answers; `waitForAndroidBoot` reports that case instead of waiting it out.
 */

const log = logger.child({ component: "mobile.android" });

export function androidSdkRoot(): string {
    return env.android.getSdkRoot();
}

/** The SDK's adb when it is there, else `adb` from PATH. */
export function adbBinary(): string {
    const sdkAdb = join(androidSdkRoot(), "platform-tools", "adb");
    return existsSync(sdkAdb) ? sdkAdb : "adb";
}

export function emulatorBinary(): string {
    return join(androidSdkRoot(), "emulator", "emulator");
}

async function run(command: string[], timeoutMs: number): Promise<BoundedCommandResult> {
    const result = await boundedCommand({ command, timeoutMs });
    log.debug({ command: command.join(" "), status: result.status, stderr: result.stderr.trim() }, "android");
    return result;
}

export function adb(serial: string, args: string[], timeoutMs = 15_000): Promise<BoundedCommandResult> {
    return run([adbBinary(), "-s", serial, ...args], timeoutMs);
}

async function adbOrThrow(serial: string, args: string[], timeoutMs?: number): Promise<string> {
    const result = await adb(serial, args, timeoutMs);
    // `am` and `pm` print their failures on stdout with exit 0.
    const failure = /^(Error|Failure)\b.*$/m.exec(result.stdout)?.[0];

    if (result.status !== 0 || failure) {
        const reason =
            failure ?? (result.stderr.trim() || result.error?.message || `exit ${result.status ?? result.signal}`);
        throw new Error(`adb -s ${serial} ${args.join(" ")} failed: ${reason}`);
    }

    return result.stdout;
}

export interface AdbDevice {
    serial: string;
    /** `device`, `offline`, `unauthorized`, … as `adb devices` reports it. */
    state: string;
    /** The `model:` field of `adb devices -l`, when adb names one. */
    model?: string;
    emulator: boolean;
}

/** Parses `adb devices -l`: one device per line after the header, `key:value` details after the state. */
export function parseAdbDevices(output: string): AdbDevice[] {
    const devices: AdbDevice[] = [];

    for (const line of output.split(/\r?\n/).slice(1)) {
        const [serial, state, ...details] = line.trim().split(/\s+/);

        if (!serial || !state) {
            continue;
        }

        const model = details.find((detail) => detail.startsWith("model:"))?.slice("model:".length);
        devices.push({ serial, state, model, emulator: serial.startsWith("emulator-") });
    }

    return devices;
}

export async function listAdbDevices(): Promise<AdbDevice[]> {
    const result = await run([adbBinary(), "devices", "-l"], 10_000);

    if (result.status !== 0) {
        log.debug({ stderr: result.stderr.trim(), error: result.error?.message }, "adb devices failed");
        return [];
    }

    return parseAdbDevices(result.stdout);
}

export async function androidProp(serial: string, name: string): Promise<string> {
    return (await adb(serial, ["shell", "getprop", name], 10_000)).stdout.trim();
}

/** The AVD an emulator runs, read through its console; undefined for a physical device. */
export async function avdName(serial: string): Promise<string | undefined> {
    const result = await adb(serial, ["emu", "avd", "name"], 10_000);
    return result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined;
}

export async function listAvds(): Promise<string[]> {
    if (!existsSync(emulatorBinary())) {
        return [];
    }

    const result = await run([emulatorBinary(), "-list-avds"], 15_000);
    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[\w.-]+$/.test(line));
}

/**
 * The emulator flags `startEmulator` passes unless told otherwise. `-gpu host` draws on the Mac's GPU through Metal:
 * an AVD's own lavapipe or SwiftShader mode draws on the CPU and, under memory pressure, starved QEMU into
 * "hanging thread" crashes. `-noaudio` saves the idle cost of the audio threads.
 */
export function emulatorCommand(options: {
    avd: string;
    port: number;
    gpu?: string;
    audio?: boolean;
    args?: string[];
}) {
    return [
        emulatorBinary(),
        "-avd",
        options.avd,
        "-port",
        String(options.port),
        "-no-snapshot-save",
        "-no-boot-anim",
        "-gpu",
        options.gpu ?? "host",
        ...(options.audio ? [] : ["-noaudio"]),
        ...(options.args ?? []),
    ];
}

/** The first even console port in 5554..5682 whose serial adb does not list, so a start never collides. */
export function freeEmulatorPort(devices: AdbDevice[]): number {
    const taken = new Set(devices.map((device) => device.serial));

    for (let port = 5554; port <= 5682; port += 2) {
        if (!taken.has(`emulator-${port}`)) {
            return port;
        }
    }

    throw new Error("every emulator console port from 5554 to 5682 is taken");
}

export type AndroidBoot = { kind: "ready" } | { kind: "offline"; state: string } | { kind: "timeout"; state: string };

/** Waits until adb answers for the serial and the guest reports `sys.boot_completed`. */
export async function waitForAndroidBoot(serial: string, timeoutMs: number): Promise<AndroidBoot> {
    const deadline = Date.now() + timeoutMs;
    let state = "missing";
    let offlineSince: number | null = null;

    while (Date.now() < deadline) {
        state = (await listAdbDevices()).find((device) => device.serial === serial)?.state ?? "missing";

        if (state === "device" && (await androidProp(serial, "sys.boot_completed")) === "1") {
            return { kind: "ready" };
        }

        offlineSince = state === "offline" ? (offlineSince ?? Date.now()) : null;

        // An emulator offline for two minutes while it runs has USB debugging off; waiting does not bring it back.
        if (offlineSince !== null && Date.now() - offlineSince > 120_000) {
            return { kind: "offline", state };
        }

        await Bun.sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
    }

    return { kind: "timeout", state };
}

function emulatorService(avd: string, command: string[]): DetachedService {
    return {
        name: `emulator ${avd}`,
        command,
        cwd: tmpdir(),
        logPath: toolDataDir("mobile", "emulator", `${avd}.log`),
        pidPath: toolDataDir("mobile", "emulator", `${avd}.pid`),
        expect: "emulator",
    };
}

/**
 * Boots an AVD as a background process this tool owns (no snapshot is saved, so every boot is clean) on a console
 * port no other emulator uses, and waits until adb answers and the guest finished booting. Returns the serial.
 */
export async function startEmulator(options: {
    avd: string;
    gpu?: string;
    audio?: boolean;
    args?: string[];
    timeoutMs: number;
}): Promise<string> {
    const port = freeEmulatorPort(await listAdbDevices());
    const serial = `emulator-${port}`;
    const command = emulatorCommand({ ...options, port });
    await startDetached(emulatorService(options.avd, command), {
        ready: async () => (await waitForAndroidBoot(serial, 5_000)).kind === "ready",
        timeoutMs: options.timeoutMs,
    });
    return serial;
}

/** `adb emu kill`, then the owned process if it is still there. */
export async function stopEmulator(serial: string): Promise<void> {
    const avd = await avdName(serial);
    await adb(serial, ["emu", "kill"], 10_000);

    if (avd) {
        await stopDetached({ name: `emulator ${avd}`, pidPath: emulatorService(avd, []).pidPath, expect: "emulator" });
    }
}

export async function installApk(serial: string, apk: string): Promise<void> {
    await adbOrThrow(serial, ["install", "-r", apk], 300_000);
}

export async function uninstallPackage(serial: string, packageName: string): Promise<void> {
    await adbOrThrow(serial, ["uninstall", packageName], 120_000);
}

export async function packageInstalled(serial: string, packageName: string): Promise<boolean> {
    const result = await adb(serial, ["shell", "pm", "path", packageName]);
    return result.status === 0 && result.stdout.includes("package:");
}

/** Starts the app: its named activity, else its launcher activity through `monkey`. */
export async function launchPackage(options: {
    serial: string;
    packageName: string;
    activity?: string;
}): Promise<void> {
    const { serial, packageName, activity } = options;

    if (activity) {
        await adbOrThrow(serial, ["shell", "am", "start", "-W", "-n", `${packageName}/${activity}`], 60_000);
        return;
    }

    await adbOrThrow(
        serial,
        ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
        60_000
    );
}

export async function forceStop(serial: string, packageName: string): Promise<void> {
    await adbOrThrow(serial, ["shell", "am", "force-stop", packageName]);
}

/** Opens a link with a VIEW intent, sent to the package when one is given so no app chooser shows. */
export async function openAndroidUrl(options: { serial: string; url: string; packageName?: string }): Promise<void> {
    const target = options.packageName ? [options.packageName] : [];
    await adbOrThrow(options.serial, [
        "shell",
        "am",
        "start",
        "-W",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        options.url,
        ...target,
    ]);
}

/** The screen as PNG bytes (`screencap -p` straight off adb's stdout). */
export async function androidScreenshot(serial: string, file: string): Promise<void> {
    const chunks: Uint8Array[] = [];
    const result = await boundedCommand({
        command: [adbBinary(), "-s", serial, "exec-out", "screencap", "-p"],
        timeoutMs: 30_000,
        maxBufferBytes: 64 * 1024 * 1024,
        onStdout: (chunk) => chunks.push(chunk),
    });

    if (result.status !== 0 || chunks.length === 0) {
        throw new Error(`adb -s ${serial} screencap failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    }

    await Bun.write(file, Buffer.concat(chunks));
}
