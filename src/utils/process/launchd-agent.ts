/**
 * One per-user launchd agent (macOS only): render its plist, install it with a restore on failure,
 * read its status, kickstart it and remove it. Every GenesisTools agent goes through here: the
 * dashboards, ai-proxy, the MCP gateway, `tools daemon`, `tools automate` and the youtube server.
 * Three hand-built copies used to drift (only one had the Homebrew PATH, one restored nothing).
 *
 * The plist sets `KeepAlive: true` + `RunAtLoad: true` so the agent survives reboots and respawns on
 * crash. The DashboardApp `down` verb explicitly unloads the plist before SIGTERM so the user's intent
 * to stop isn't defeated by launchd respawning the process immediately.
 *
 * `ThrottleInterval` is 10s. At the old 2s a dashboard that died during startup respawned faster than
 * it could finish a Vite build, so the public port stayed down for the whole storm.
 *
 * Every `launchctl` call goes through one `LaunchctlRunner`, so tests swap it and never load a job.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { wrapWithGenesisApp } from "@genesiscz/utils/macos/genesis-app";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { boundedCommand } from "./bounded-command";

const realLaunchAgentsDir = (): string => join(homedir(), "Library", "LaunchAgents");
let launchAgentsDir: () => string = realLaunchAgentsDir;

export function defaultPlistLabel(key: string): string {
    return `com.genesis-tools.${key}`;
}

export function plistPath(label: string): string {
    return join(launchAgentsDir(), `${label}.plist`);
}

export function isLaunchdInstalled(label: string): boolean {
    if (process.platform !== "darwin") {
        return false;
    }

    return existsSync(plistPath(label));
}

/** The plist `ProcessType` key. launchd applies resource limits and QoS by it. */
export type LaunchdProcessType = "Standard" | "Background" | "Adaptive" | "Interactive";

export interface LaunchdLogPaths {
    stdout: string;
    stderr: string;
}

interface LaunchdAgentSpec {
    label: string;
    command: readonly string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    /** Omitted: no `ProcessType` key, so launchd uses its default. */
    processType?: LaunchdProcessType;
}

/** One log file for both streams, or a file per stream. */
type LaunchdLogTarget = { logFile: string; logPaths?: never } | { logPaths: LaunchdLogPaths; logFile?: never };

export type LaunchdInstallOptions = LaunchdAgentSpec & LaunchdLogTarget;

/** The PATH a launchd agent gets: it inherits no shell profile, so Homebrew and the command's own folder are named. */
export function launchdDefaultPath(binDir: string): string {
    return `/usr/local/bin:/opt/homebrew/bin:${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

/** Resolve bare executable names and inject a launchd-safe PATH (no shell profile). */
export function resolveCommandForLaunchd(
    command: readonly string[],
    cwd?: string
): {
    command: string[];
    env: Record<string, string>;
} {
    const workdir = cwd ?? process.cwd();
    const resolved = [...command];
    const first = resolved[0];

    if (first && !first.includes("/")) {
        const abs = Bun.which(first) ?? (first === "bun" ? process.execPath : undefined);

        if (abs) {
            resolved[0] = abs;
        }
    }

    for (let i = 1; i < resolved.length; i++) {
        const arg = resolved[i];

        if (!arg || arg.startsWith("-") || arg.startsWith("/")) {
            continue;
        }

        if (arg.includes("/")) {
            resolved[i] = resolve(workdir, arg);
        }
    }

    const binDir = dirname(resolved[0] ?? "/usr/bin");
    const env: Record<string, string> = {
        HOME: homedir(),
        PATH: launchdDefaultPath(binDir),
    };

    return { command: resolved, env };
}

export async function bootoutLaunchd(label: string): Promise<void> {
    if (process.platform !== "darwin") {
        return;
    }

    const path = plistPath(label);

    if (!existsSync(path)) {
        return;
    }

    const uid = process.getuid?.();

    if (uid !== undefined) {
        await launchctl(["bootout", `gui/${uid}`, path]).catch(() => undefined);
    }

    await launchctl(["unload", path]).catch(() => undefined);
}

export interface InstallLaunchdBehavior {
    /** `kickstart -k` after a successful load (default true). A RunAtLoad job already started on load. */
    kickstart?: boolean;
}

/**
 * Idempotent: a loaded job is unloaded first, so re-running install (for example to migrate) reloads
 * the new plist. The previous plist bytes are kept and, if the write or the load fails, written back
 * and loaded again, so a failed install never leaves the user with no agent at all.
 */
export async function installLaunchd(
    opts: LaunchdInstallOptions,
    behavior: InstallLaunchdBehavior = {}
): Promise<void> {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    const path = plistPath(opts.label);
    const previous = readPreviousPlist(path);

    if (previous) {
        await launchctl(["unload", path]).catch(() => undefined);
    }

    try {
        writeLaunchdPlist(opts);

        if (!previous) {
            // A job can stay loaded after its plist file was deleted; `load` would then fail on "already loaded".
            await launchctl(["unload", path]).catch(() => undefined);
        }

        const { exitCode, stderr } = await launchctl(["load", path]);

        if (exitCode !== 0) {
            throw new Error(
                `launchctl load ${path} failed with exit code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
            );
        }
    } catch (error) {
        await restorePreviousPlist({ path, previous, cause: error });
        throw error;
    }

    if (behavior.kickstart ?? true) {
        await kickstartLaunchd(opts.label);
    }
}

interface PreviousPlist {
    bytes: Buffer;
    mode: number;
}

function readPreviousPlist(path: string): PreviousPlist | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    return { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 };
}

/**
 * Put the old plist back and reload it; a restore failure must not mask the original error.
 * `launchctl load` reports failure through its exit code, not by rejecting, so claiming recovery
 * without reading that code would announce a running agent that is in fact still unloaded.
 */
async function restorePreviousPlist({
    path,
    previous,
    cause,
}: {
    path: string;
    previous: PreviousPlist | undefined;
    cause: unknown;
}): Promise<void> {
    if (!previous) {
        return;
    }

    try {
        atomicWriteFileSync(path, previous.bytes, { mode: previous.mode });
        const { exitCode, stderr } = await launchctl(["load", path]);

        if (exitCode !== 0) {
            logger.error(
                { cause, plist: path, exitCode, stderr: stderr.trim() },
                "launchd install failed; the previous plist was written back but launchctl load failed, so no agent is loaded"
            );
            return;
        }

        logger.warn({ err: cause, plist: path }, "launchd install failed; previous plist restored and reloaded");
    } catch (restoreError) {
        logger.error(
            { err: restoreError, cause, plist: path },
            "launchd install failed AND the previous plist could not be restored"
        );
    }
}

/** The plist text for an agent. Pure apart from resolving the command and the GenesisTools.app launcher. */
export function renderLaunchdPlist(opts: LaunchdInstallOptions): string {
    const { command: bareCommand, env: baseEnv } = resolveCommandForLaunchd(opts.command, opts.cwd);
    // launchd jobs have no terminal to inherit TCC grants from; run them under GenesisTools.app
    // when it is built, so the service shares the grants the CLI already has.
    const resolvedCommand = wrapWithGenesisApp(bareCommand);
    const mergedEnv: Record<string, string> = { ...baseEnv };

    for (const [key, value] of Object.entries(opts.env ?? {})) {
        if (value !== undefined) {
            mergedEnv[key] = value;
        }
    }

    const logs = logPathsOf(opts);
    const programArgs = resolvedCommand.map((arg) => `        <string>${escapeXml(arg)}</string>`).join("\n");
    const envEntries = Object.entries(mergedEnv)
        .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
        .join("\n");
    const cwdBlock = opts.cwd ? `    <key>WorkingDirectory</key>\n    <string>${escapeXml(opts.cwd)}</string>\n` : "";
    const processTypeBlock = opts.processType
        ? `    <key>ProcessType</key>\n    <string>${escapeXml(opts.processType)}</string>\n`
        : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
${cwdBlock}    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
${processTypeBlock}    <key>StandardOutPath</key>
    <string>${escapeXml(logs.stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logs.stderr)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
</dict>
</plist>
`;
}

function logPathsOf(opts: LaunchdInstallOptions): LaunchdLogPaths {
    if (opts.logPaths) {
        return opts.logPaths;
    }

    return { stdout: opts.logFile, stderr: opts.logFile };
}

/** Rewrite plist on disk — used when refreshing env/cmd/throttle without full reinstall. */
export function writeLaunchdPlist(opts: LaunchdInstallOptions): void {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    // EnvironmentVariables can carry provider API keys, so the plist must never be group/world-readable,
    // not even for an instant. The temp file gets exactly 0600 (umask cannot strip it) before it is
    // renamed over the old plist, so the live file is never truncated or half-written either.
    atomicWriteFileSync(plistPath(opts.label), renderLaunchdPlist(opts), { mode: 0o600 });
}

export async function refreshLaunchd(opts: LaunchdInstallOptions): Promise<void> {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    writeLaunchdPlist(opts);

    const path = plistPath(opts.label);
    await launchctl(["load", path]).catch(() => undefined);
    await kickstartLaunchd(opts.label);
}

export async function kickstartLaunchd(label: string): Promise<void> {
    if (process.platform !== "darwin") {
        return;
    }

    const uid = process.getuid?.();

    if (uid === undefined) {
        return;
    }

    try {
        // launchctl() itself never rejects (always resolves {exitCode, stderr}); this catch
        // only guards against Bun.spawn throwing synchronously before that (e.g. ENOENT).
        const { exitCode, stderr } = await launchctl(["kickstart", "-k", `gui/${uid}/${label}`]);

        if (exitCode !== 0) {
            logger.warn(
                { exitCode, stderr: stderr.trim(), label },
                "[launchd] kickstart -k failed; service may not have restarted"
            );
        }
    } catch (err) {
        logger.warn({ err, label }, "[launchd] kickstart -k failed; service may not have restarted");
    }
}

/** Load plist if needed and kickstart — faster than rewriting the plist on restart. */
export async function startLaunchd(label: string): Promise<void> {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    const path = plistPath(label);

    if (!existsSync(path)) {
        throw new Error(`launchd plist missing: ${path}`);
    }

    // `load` is not idempotent: on an already-loaded job it exits non-zero with
    // "service already loaded". That is the NORMAL post-boot state (RunAtLoad
    // loads the plist, the process then crashes and sits in its throttle
    // window), and `up` used to error out on it instead of kickstarting the job
    // it had just found. `installLaunchd` unloads first for the same reason.
    await launchctl(["unload", path]).catch(() => undefined);
    const loaded = await launchctl(["load", path]);

    if (loaded.exitCode !== 0) {
        throw new Error(
            `launchctl load ${path} failed with exit code ${loaded.exitCode}${loaded.stderr.trim() ? `: ${loaded.stderr.trim()}` : ""}`
        );
    }

    await kickstartLaunchd(label);
}

export async function uninstallLaunchd(label: string): Promise<void> {
    if (process.platform !== "darwin") {
        return;
    }

    const path = plistPath(label);

    if (existsSync(path)) {
        await launchctl(["unload", path]).catch(() => undefined);
        unlinkSync(path);
    }
}

export interface LaunchdStatus {
    /** launchd knows the job (`launchctl print` found it). */
    loaded: boolean;
    /** The running process; absent when the job is loaded but not running. */
    pid?: number;
}

/**
 * The PID in `launchctl` output. Two forms exist: the plain `pid = 123` line of `launchctl print`
 * and the dict form `"PID" = 123;` of `launchctl list <label>`. Both are read.
 */
export function parseLaunchdPid(stdout: string): number | undefined {
    const match = stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m) ?? stdout.match(/"PID"\s*=\s*(\d+);?/);
    const pid = match?.[1] ? Number.parseInt(match[1], 10) : undefined;
    return pid !== undefined && pid > 0 ? pid : undefined;
}

/** Whether launchd has the job loaded, and its PID when it runs. Reads only. */
export async function launchdStatus(label: string): Promise<LaunchdStatus> {
    if (process.platform !== "darwin") {
        return { loaded: false };
    }

    const uid = process.getuid?.();

    if (uid === undefined) {
        return { loaded: false };
    }

    const { exitCode, stdout } = await launchctl(["print", `gui/${uid}/${label}`]);

    if (exitCode !== 0) {
        return { loaded: false };
    }

    const pid = parseLaunchdPid(stdout);
    return pid === undefined ? { loaded: true } : { loaded: true, pid };
}

export interface LaunchctlResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export type LaunchctlRunner = (args: readonly string[]) => Promise<LaunchctlResult>;

/** A launchctl verb answers in well under a second; a stalled one must not block install, rollback or status. */
const LAUNCHCTL_TIMEOUT_MS = 30_000;

/** The exit code of a command that hit its deadline (the `timeout(1)` convention). */
export const LAUNCHCTL_TIMEOUT_EXIT_CODE = 124;

/**
 * Run one launchctl command under a deadline. At the deadline the whole process group is terminated and reaped, and the
 * result is exit code 124 with a stderr that says so, so every caller takes its ordinary failure path.
 */
export async function runLaunchctlCommand(command: string[], timeoutMs: number): Promise<LaunchctlResult> {
    const result = await boundedCommand({ command, timeoutMs });

    if (result.error?.code === "ETIMEDOUT") {
        logger.warn({ command, timeoutMs }, "launchctl passed its deadline and was killed");
        return {
            exitCode: LAUNCHCTL_TIMEOUT_EXIT_CODE,
            stdout: result.stdout,
            stderr: `${command.join(" ")} timed out after ${timeoutMs} ms`,
        };
    }

    if (result.error) {
        return { exitCode: 1, stdout: result.stdout, stderr: result.error.message };
    }

    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

const spawnLaunchctl: LaunchctlRunner = (args) => runLaunchctlCommand(["launchctl", ...args], LAUNCHCTL_TIMEOUT_MS);

let launchctlRunner: LaunchctlRunner = spawnLaunchctl;

/**
 * Swap the `launchctl` runner. Tests only: loading a real agent to assert the
 * load sequence would leave a job on the developer's machine when they abort.
 * Pass `null` to restore.
 */
export function _setLaunchctlRunnerForTests(runner: LaunchctlRunner | null): void {
    launchctlRunner = runner ?? spawnLaunchctl;
}

/**
 * Point the plist folder somewhere else. Tests only: a plist written into the real
 * `~/Library/LaunchAgents` is loaded at the next login. Pass `null` to restore.
 */
export function _setLaunchAgentsDirForTests(dir: string | null): void {
    launchAgentsDir = dir ? () => dir : realLaunchAgentsDir;
}

function launchctl(args: readonly string[]): Promise<LaunchctlResult> {
    return launchctlRunner(args);
}

function escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
