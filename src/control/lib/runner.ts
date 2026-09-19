import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentSessionIds } from "@genesiscz/utils/agent/host";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    assertGenesisAppNotUpdating,
    GenesisAppUpdatingError,
    installedGenesisAppLauncher,
} from "@genesiscz/utils/macos/genesis-app";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { profiler } from "@genesiscz/utils/profile";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { captureNativeSources, nativeNeedsBuild, recordNativeBuild } from "./native-build";

const GT_ROOT = join(import.meta.dir, "..", "..", "..");
const BINARY_PATH = join(GT_ROOT, "native", "ax-tool", ".build", "release", "ax-tool");
const SWIFT_SOURCE = join(GT_ROOT, "native", "ax-tool");
const prof = profiler.scope("control-native");

export const RECORD_DIR = join(env.tools.getHome(), ".genesis-tools", "control", "record");
export const RECORD_SESSION = join(RECORD_DIR, "session.json");
const RECORDED_COMMANDS = new Set([
    "press",
    "click",
    "set",
    "type",
    "hotkey",
    "focus",
    "scroll",
    "perform",
    "screenshot",
    "window",
]);

/**
 * Best-effort identity of the terminal/session running this command — lets
 * record-plan flag commands spliced in by OTHER concurrent sessions.
 * Same-session subagents share these envs and stay indistinguishable.
 * Every agent host contributes its id, so two concurrent grok or codex sessions
 * are told apart the same way two Claude Code sessions are.
 */
export function recordSource(): string {
    const e = env.getProcessEnv();
    const agentIds = agentSessionIds(e).map((s) => s.id);
    const parts = [...agentIds, e.ITERM_SESSION_ID, e.TERM_SESSION_ID, e.TMUX_PANE].filter(Boolean);
    return parts.length ? parts.join(":") : "unknown";
}

/** When a record-plan session is active, log action commands for plan synthesis. */
function maybeRecord(args: string[], ok: boolean): void {
    if (!existsSync(RECORD_SESSION)) {
        return;
    }
    const cmd = args[0];
    if (!cmd || !RECORDED_COMMANDS.has(cmd)) {
        return;
    }
    try {
        const session = SafeJSON.parse(readFileSync(RECORD_SESSION, "utf-8")) as { mode?: string };
        if (session.mode !== "commands" && session.mode !== "all") {
            return;
        }
        appendFileSync(
            join(RECORD_DIR, "commands.jsonl"),
            `${SafeJSON.stringify({ ts: Date.now(), ok, src: recordSource(), args })}\n`
        );
    } catch (error) {
        logger.debug({ error }, "could not record control command");
    }
}

export interface AxResult {
    ok: boolean;
    error?: string;
    [key: string]: unknown;
}

/** Recovery never renews the snapshot or changes its target fingerprint. */
export class PreparedActionRecovery {
    private readonly clock = new Stopwatch();
    private recoveryStarted?: number;
    private readonly refusals: string[] = [];
    constructor(private readonly options: { args: string[]; timeoutMs: number; signal?: AbortSignal }) {}

    remaining(): number {
        return Math.floor(this.options.timeoutMs - this.clock.elapsedMs);
    }

    retry(result: AxResult): boolean {
        const { args, signal } = this.options;
        const key = args[args.indexOf("--target-key") + 1];
        if (
            result.ok ||
            result.dispatchState !== "not_started" ||
            !["stale_observation", "focus_mismatch"].includes(String(result.refusal)) ||
            args[0] !== "act" ||
            !args.includes("--prepare") ||
            !args.includes("--target-key") ||
            !/^[a-f0-9]{64}$/.test(key ?? "") ||
            args.includes("--coords") ||
            args.includes("--region") ||
            this.refusals.length >= 2 ||
            (this.recoveryStarted !== undefined && this.clock.elapsedMs - this.recoveryStarted >= 1500) ||
            signal?.aborted ||
            this.remaining() < 1
        ) {
            return false;
        }
        this.recoveryStarted ??= this.clock.elapsedMs;
        this.refusals.push(String(result.refusal));
        logger.debug(
            { attempt: this.refusals.length + 1, refusal: result.refusal },
            "Retrying undispatched prepared action"
        );
        return true;
    }

    finish(result: AxResult): AxResult {
        return this.refusals.length
            ? {
                  ...result,
                  recovery: { retries: this.refusals.length, refusals: this.refusals, elapsedMs: this.clock.elapsedMs },
              }
            : result;
    }
}

export async function runAxAsyncWithRecovery(options: {
    args: string[];
    timeoutMs: number;
    signal?: AbortSignal;
    run: (timeoutMs: number) => Promise<AxResult>;
}): Promise<AxResult> {
    const recovery = new PreparedActionRecovery(options);
    let result: AxResult;
    do {
        if (options.signal?.aborted || recovery.remaining() < 1) {
            return recovery.finish({
                ok: false,
                dispatchState: "not_started",
                error: "Recovery deadline or cancellation reached before dispatch.",
            });
        }
        try {
            result = await options.run(recovery.remaining());
        } catch (error) {
            logger.warn({ error, command: options.args[0] }, "Native transport failed; no further retry");
            result =
                error instanceof GenesisAppUpdatingError
                    ? { ok: false, dispatchState: "not_started", refusal: "launcher_updating", error: error.message }
                    : {
                          ok: false,
                          dispatchState: "uncertain",
                          error: "Native transport failed; action delivery is unknown. No further retry.",
                      };
        }
    } while (recovery.retry(result));
    return recovery.finish(result);
}

/**
 * Per-process memo of the freshness verdict.
 *
 * `ensureBinary` sits on the hot path of every `runAx`, and `nativeNeedsBuild` answers by
 * re-hashing every Swift source plus the whole binary — about 2 ms measured against the
 * 11-file, 697 kB tree. The sources cannot change under a command that is already running,
 * so one verdict per process is enough, and a see→act→see loop pays it once rather than
 * per call. Only a verified-fresh or freshly-built binary is memoized; a failed build is not.
 */
let verifiedBinary: string | null = null;

export function ensureBinary(): string {
    if (verifiedBinary !== null) {
        return verifiedBinary;
    }

    if (!nativeNeedsBuild({ binary: BINARY_PATH, sourceDir: SWIFT_SOURCE })) {
        verifiedBinary = BINARY_PATH;
        return verifiedBinary;
    }

    if (existsSync(join(SWIFT_SOURCE, "Package.swift"))) {
        logger.info({ source: SWIFT_SOURCE }, "ax-tool binary missing or stale; compiling native CLI");
        const before = captureNativeSources(SWIFT_SOURCE);
        const r = spawnSync("swift", ["build", "-c", "release"], {
            cwd: SWIFT_SOURCE,
            timeout: 120_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        if (r.status === 0 && existsSync(BINARY_PATH)) {
            recordNativeBuild({ binary: BINARY_PATH, sourceDir: SWIFT_SOURCE, before });
            logger.info("ax-tool built successfully");
            verifiedBinary = BINARY_PATH;
            return verifiedBinary;
        }
        const details = [r.error?.message, r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).join("\n");
        throw new Error(`ax-tool build failed (${r.status ?? r.signal ?? "spawn error"}):\n${details.slice(-4000)}`);
    }

    throw new Error(
        `ax-tool native binary not found at ${BINARY_PATH}.\n` +
            `Build it with: bun run build:native  (or: cd ${SWIFT_SOURCE} && swift build -c release)\n` +
            `Requires: macOS with Swift toolchain (Xcode or swift.org toolchain)`
    );
}

export interface AxSpawnRequest {
    binary: string;
    args: string[];
    timeoutMs: number;
    maxBufferBytes: number;
}

export interface AxSpawnResult {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string | null;
    stderr: string | null;
    error?: Error & { code?: string };
}

export interface AxRunBoundary {
    ensureBinary: () => string;
    spawn: (options: AxSpawnRequest) => AxSpawnResult;
}

export const AX_STDOUT_BUDGET_BYTES = 32 * 1024 * 1024;

/** Argv the AX spawn will exec: launcher + binary + args when a launcher is installed. */
export function axCommandLine(binary: string, args: readonly string[]): string[] {
    assertGenesisAppNotUpdating();
    const launcher = installedGenesisAppLauncher();
    return launcher ? [launcher, binary, ...args] : [binary, ...args];
}

export const DEFAULT_AX_RUN_BOUNDARY: AxRunBoundary = {
    ensureBinary,
    spawn: ({ binary, args, timeoutMs, maxBufferBytes }) => {
        // Accessibility is granted to GenesisTools.app, and ax-tool only holds it while the app is
        // its responsible process. Re-entering through the launcher on every call is what
        // guarantees that.
        //
        // ⚠️ `installedGenesisAppLauncher()`, NOT `genesisAppLauncher()`. The latter returns null
        // when the CALLING process already runs under the app, assuming responsibility is
        // inherited. That holds for file and Calendar grants but NOT for Accessibility down a long
        // descendant chain: any session started through the launcher (a `gt-cc` Claude Code run, a
        // dashboard) therefore ran ax-tool unwrapped, every AX subcommand returned "no windows",
        // and that reads as a fact about the target app rather than a missing grant.
        const argv = axCommandLine(binary, args);
        const command = argv[0] ?? binary;
        const commandArgs = argv.slice(1);

        const result = spawnSync(command, commandArgs, {
            timeout: timeoutMs,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            maxBuffer: maxBufferBytes,
        });
        return {
            status: result.status,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.error,
        };
    },
};

function isAxResult(value: unknown): value is AxResult {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as { ok?: unknown }).ok === "boolean"
    );
}

export function runAxWithBoundary({
    args,
    timeoutMs = 10_000,
    boundary,
}: {
    args: string[];
    timeoutMs?: number;
    boundary: AxRunBoundary;
}): AxResult {
    timeoutMs = Math.floor(timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
        return {
            ok: false,
            dispatchState: "not_started",
            error: "Native timeout must be a finite duration of at least 1 ms and at most 2147483647 ms.",
        };
    }
    logger.debug({ command: args[0], timeoutMs }, "running native control command");
    let binary: string;
    try {
        binary = boundary.ensureBinary();
    } catch (error) {
        logger.error({ error }, "native control build unavailable");
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const recovery = new PreparedActionRecovery({ args, timeoutMs });
    let r: ReturnType<AxRunBoundary["spawn"]>;
    let result: AxResult;
    do {
        try {
            const remainingMs = recovery.remaining();
            if (remainingMs < 1) {
                return recovery.finish({
                    ok: false,
                    dispatchState: "not_started",
                    error: "Recovery deadline reached before dispatch.",
                });
            }
            r = boundary.spawn({ binary, args, timeoutMs: remainingMs, maxBufferBytes: AX_STDOUT_BUDGET_BYTES });
        } catch (error) {
            logger.warn({ error, command: args[0] }, "Native spawn failed; no retry");
            if (error instanceof GenesisAppUpdatingError) {
                return recovery.finish({
                    ok: false,
                    dispatchState: "not_started",
                    refusal: "launcher_updating",
                    error: error.message,
                });
            }
            return recovery.finish({
                ok: false,
                dispatchState: "uncertain",
                error: "Native spawn failed; the action may have partially completed. No retry was attempted.",
            });
        }

        result = interpretNativeResult({ args, result: r, timeoutMs });
    } while (recovery.retry(result));
    return recovery.finish(result);
}

export function interpretNativeResult({
    args,
    result: r,
    timeoutMs,
}: {
    args: string[];
    result: AxSpawnResult;
    timeoutMs: number;
}): AxResult {
    if (r.error?.code === "ENOBUFS") {
        return {
            ok: false,
            error: "native output exceeded the 32 MiB per-stream budget; the command may have partially completed; no retry was attempted",
        };
    }

    if (r.error?.code === "ETIMEDOUT") {
        return {
            ok: false,
            error: `native execution timed out after ${timeoutMs}ms; the action may have partially completed; no retry was attempted`,
        };
    }

    if (r.error) {
        return {
            ok: false,
            error: `native execution failed: ${r.error.message}; the action may have partially completed; no retry was attempted`,
        };
    }

    const stdout = (r.stdout ?? "").trim();
    if (!stdout) {
        maybeRecord(args, false);
        return { ok: false, error: r.stderr?.trim() || `ax-tool exited ${r.status} with no output` };
    }

    try {
        const parsed = SafeJSON.parse(stdout, { strict: true });
        if (!isAxResult(parsed)) {
            maybeRecord(args, false);
            return { ok: false, error: `invalid native result envelope: ${stdout.slice(0, 200)}` };
        }

        if (r.signal) {
            parsed.ok = false;
            if (parsed.dispatchState !== undefined) {
                parsed.dispatchState = "uncertain";
            }
            parsed.error ??= `native command terminated by ${r.signal}; the action may have partially completed; no retry was attempted`;
        } else if (r.status !== 0) {
            parsed.ok = false;
            parsed.error ??= `native command exited ${r.status}`;
        }

        logger.debug(
            {
                command: args[0],
                ok: parsed.ok,
                error: parsed.error,
                dispatchState: parsed.dispatchState,
                refusal: parsed.refusal,
                reason: parsed.reason,
                responsiblePid: parsed.responsiblePid,
                responsibleBundleId: parsed.responsibleBundleId,
                responsiblePath: parsed.responsiblePath,
                viaGenesisApp: parsed.viaGenesisApp,
            },
            "native control completed"
        );
        maybeRecord(args, parsed.ok);
        return parsed;
    } catch (error) {
        logger.debug({ error, command: args[0] }, "native control returned invalid JSON");
        maybeRecord(args, false);
        return { ok: false, error: `invalid JSON: ${stdout.slice(0, 200)}` };
    }
}

let cursorFeedbackEnabled = true;
export function setCursorFeedbackEnabled(enabled: boolean): void {
    cursorFeedbackEnabled = enabled;
}
function nativeArguments(args: string[]): string[] {
    const mutating = [
        "act",
        "menu-act",
        "set",
        "press",
        "perform",
        "focus",
        "click",
        "type",
        "scroll",
        "hotkey",
        "window",
    ].includes(args[0]);
    return !cursorFeedbackEnabled && mutating ? [...args, "--no-cursor"] : args;
}

export function runAx(args: string[], timeoutMs = 10_000): AxResult {
    return runAxWithBoundary({ args: nativeArguments(args), timeoutMs, boundary: DEFAULT_AX_RUN_BOUNDARY });
}

export async function runAxAsync(options: {
    args: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<AxResult> {
    const clock = new Stopwatch();
    const timeoutMs = Math.floor(options.timeoutMs ?? 10000);
    if (options.signal?.aborted || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
        return {
            ok: false,
            dispatchState: "not_started",
            error: "Native command cancelled or deadline invalid before dispatch.",
        };
    }
    const args = nativeArguments(options.args);
    let binary: string;
    try {
        binary = ensureBinary();
    } catch (error) {
        logger.error({ error }, "Native build unavailable");
        return { ok: false, dispatchState: "not_started", error: "Native build unavailable; no action dispatched." };
    }
    const remainingMs = Math.floor(timeoutMs - clock.elapsedMs);
    if (remainingMs < 1 || options.signal?.aborted) {
        return { ok: false, dispatchState: "not_started", error: "Native command deadline reached before dispatch." };
    }
    logger.debug({ command: args[0], timeoutMs: remainingMs }, "Running asynchronous native control command");
    try {
        const interpreted = await runAxAsyncWithRecovery({
            args,
            timeoutMs: remainingMs,
            signal: options.signal,
            run: async (attemptTimeoutMs) => {
                const result = await prof.measureAsync(`ax-${args[0]}`, () =>
                    boundedCommand({
                        command: axCommandLine(binary, args),
                        timeoutMs: attemptTimeoutMs,
                        maxBufferBytes: AX_STDOUT_BUDGET_BYTES,
                        signal: options.signal,
                    })
                );
                return interpretNativeResult({ args, result, timeoutMs: attemptTimeoutMs });
            },
        });
        logger.debug(
            {
                command: args[0],
                ms: Math.round(clock.elapsedMs),
                ok: interpreted.ok,
                dispatchState: interpreted.dispatchState,
                error: interpreted.error,
            },
            "Asynchronous native control command finished"
        );
        return interpreted;
    } catch (error) {
        logger.warn({ error, command: args[0] }, "Native transport failed; no retry");
        if (error instanceof GenesisAppUpdatingError) {
            return { ok: false, dispatchState: "not_started", refusal: "launcher_updating", error: error.message };
        }
        return {
            ok: false,
            dispatchState: "uncertain",
            error: "Native transport failed; action delivery is unknown. No retry.",
        };
    }
}

export function getBinaryPath(): string {
    return BINARY_PATH;
}
