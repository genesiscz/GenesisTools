import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { isTestProcess } from "@genesiscz/utils/test-process";
import { NATIVE_BUILD_WORKER_TIMEOUT_MS, nativeNeedsBuild } from "./native-build";

const GT_ROOT = join(import.meta.dir, "..", "..", "..");
const BINARY_PATH = join(GT_ROOT, "native", "ax-tool", ".build", "release", "ax-tool");
const SWIFT_SOURCE = join(GT_ROOT, "native", "ax-tool");
const BUILD_WORKER = join(import.meta.dir, "native-build-worker.ts");
const BUILD_LOCK = join(SWIFT_SOURCE, ".build", "ax-tool-build.lock");

interface BuildOutcome {
    ok: boolean;
    built?: boolean;
    error?: string;
}

function isBuildOutcome(value: unknown): value is BuildOutcome {
    return value !== null && typeof value === "object" && "ok" in value && typeof value.ok === "boolean";
}

/** The build worker's one-line verdict on stdout. */
function parseBuildOutcome(stdout: string | null): BuildOutcome | null {
    try {
        const parsed: unknown = SafeJSON.parse((stdout ?? "").trim(), { strict: true });

        if (isBuildOutcome(parsed)) {
            return parsed;
        }
    } catch (error) {
        logger.debug({ error, stdout: stdout?.slice(0, 200) }, "native build worker printed no verdict");
    }

    return null;
}

const prof = profiler.scope("control-native");

/** Deliberate opt-in for a test that must run the real ax-tool. Nothing in the default suite sets it. */
export const REAL_AX_TOOL_IN_TESTS = "GENESIS_TOOLS_ALLOW_REAL_AX_TOOL_IN_TESTS";

/**
 * A test reached the real ax-tool. Every catch in this file rethrows it rather than folding it into
 * an `{ ok: false }` result: a swallowed refusal reads as "the app has no windows", and the test
 * passes on it.
 */
export class RealMachineInTestError extends Error {
    constructor(what: string) {
        super(`a test reached the real machine through ${what}; inject a fixture binary, spawn or transport instead`);
        this.name = "RealMachineInTestError";
    }
}

/**
 * Every real input, screen read and click goes through ax-tool, and the suite runs on the
 * developer's own Mac while they use it. So under the test runner the real binary is never handed
 * out, built or spawned. The opt-in is the injection runner.test.ts already used: an
 * `AxRunBoundary` whose `ensureBinary` names a fixture (the real spawn then runs the fixture), a
 * `transport` for the persistent session, a `run` for the asynchronous driver. None of those names
 * the real binary, so none of them needs a flag. Ported from typesafe-computer-use
 * `tests/conftest.py` (`no_real_machine`).
 */
export function refuseRealMachineInTest(what: string): void {
    if (!isTestProcess() || env.isFlag(REAL_AX_TOOL_IN_TESTS)) {
        return;
    }

    throw new RealMachineInTestError(what);
}

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
    private readonly refusedAttempts: string[] = [];
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
        this.refusedAttempts.push(String(result.error ?? result.refusal));
        logger.debug(
            { attempt: this.refusals.length + 1, refusal: result.refusal },
            "Retrying undispatched prepared action"
        );
        return true;
    }

    /**
     * A retried call whose last attempt found the target changed or gone did not post its input, but
     * it cannot claim that nothing happened: an earlier attempt had already activated, raised and
     * focused the target, and the UI moved while the call ran. Measured 2026-09-28 on Brave: a
     * prepared Return was refused at the focus gate, the retry found the omnibox changed, and the
     * page had navigated. Reported as not started, that invites the caller to press Return again.
     */
    finish(result: AxResult): AxResult {
        if (!this.refusals.length) {
            return result;
        }

        const recovery = { retries: this.refusals.length, refusals: this.refusals, elapsedMs: this.clock.elapsedMs };
        const movedUnderUs =
            result.dispatchState === "not_started" &&
            ["missing_target", "stale_observation", "scope_changed"].includes(String(result.refusal));
        if (!movedUnderUs) {
            return { ...result, recovery };
        }

        const attempts = [...this.refusedAttempts, String(result.error ?? result.refusal)]
            .map((error, index) => `attempt ${index + 1}: ${error}`)
            .join("; ");
        return {
            ...result,
            dispatchState: "uncertain",
            recovery: { ...recovery, targetChanged: true },
            error:
                `No attempt posted the input (${attempts}). The target changed while this call ran, after an ` +
                "earlier attempt had activated and focused it, so a preparation step or another actor changed the UI. " +
                "Observe before repeating the input.",
        };
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
            if (error instanceof RealMachineInTestError) {
                throw error;
            }

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
    refuseRealMachineInTest("ax-tool (ensureBinary hands out, and may build, the real binary)");
    if (verifiedBinary !== null) {
        return verifiedBinary;
    }

    if (!nativeNeedsBuild({ binary: BINARY_PATH, sourceDir: SWIFT_SOURCE })) {
        verifiedBinary = BINARY_PATH;
        return verifiedBinary;
    }

    if (existsSync(join(SWIFT_SOURCE, "Package.swift"))) {
        logger.info({ source: SWIFT_SOURCE }, "ax-tool binary missing or stale; compiling native CLI");
        // The worker holds a cross-process lock around check-and-build, so concurrent first runs
        // compile once; ensureBinary stays synchronous because every runAx caller is.
        const r = spawnSync(process.execPath, [BUILD_WORKER, BINARY_PATH, SWIFT_SOURCE, BUILD_LOCK], {
            timeout: NATIVE_BUILD_WORKER_TIMEOUT_MS,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "inherit"],
        });
        const outcome = parseBuildOutcome(r.stdout);
        if (r.status === 0 && outcome?.ok && existsSync(BINARY_PATH)) {
            logger.info(
                outcome.built ? "ax-tool built successfully" : "ax-tool was built by another process; reusing it"
            );
            verifiedBinary = BINARY_PATH;
            return verifiedBinary;
        }
        const details = [r.error?.message, outcome?.error ?? r.stdout?.trim()].filter(Boolean).join("\n");
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
/**
 * `see` and `act` learn the deadline of the attempt they run in. Without it a slow tree (a sheet
 * listing thousands of files, read through a remote view) walked until this side killed the
 * process at its deadline, and the dispatched result died with it. Added per attempt, so a
 * recovery retry carries its own, shorter deadline while every other argument stays the same.
 */
export function withNativeBudget(args: string[], timeoutMs: number): string[] {
    if (!["see", "act", "preflight"].includes(args[0] ?? "") || args.includes("--budget-ms")) {
        return args;
    }

    return [...args, "--budget-ms", String(Math.min(600_000, Math.max(100, Math.floor(timeoutMs))))];
}

export function axCommandLine(binary: string, args: readonly string[]): string[] {
    if (resolve(binary) === BINARY_PATH) {
        refuseRealMachineInTest(`ax-tool ${args.join(" ")}`);
    }

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
        if (error instanceof RealMachineInTestError) {
            throw error;
        }

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
            r = boundary.spawn({
                binary,
                args: withNativeBudget(args, remainingMs),
                timeoutMs: remainingMs,
                maxBufferBytes: AX_STDOUT_BUDGET_BYTES,
            });
        } catch (error) {
            if (error instanceof RealMachineInTestError) {
                throw error;
            }

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

/**
 * A paste that is told to stop restores the clipboard and prints the outcome before it exits. The
 * timeout result keeps only that field: the rest of a terminated process's envelope is not
 * evidence of what the action did.
 */
function terminatedClipboard(stdout: string | null): { clipboardRestore?: string } {
    const lastLine = (stdout ?? "").trim().split("\n").at(-1);
    if (!lastLine) {
        return {};
    }

    try {
        const parsed: unknown = SafeJSON.parse(lastLine, { strict: true });
        if (isAxResult(parsed) && typeof parsed.clipboardRestore === "string") {
            return { clipboardRestore: parsed.clipboardRestore };
        }
    } catch (error) {
        logger.debug({ error }, "terminated native command printed no parseable result");
    }

    return {};
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
            ...terminatedClipboard(r.stdout),
        };
    }

    if (r.error) {
        return {
            ok: false,
            error: `native execution failed: ${r.error.message}; the action may have partially completed; no retry was attempted`,
            ...terminatedClipboard(r.stdout),
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
        if (error instanceof RealMachineInTestError) {
            throw error;
        }

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
                        command: axCommandLine(binary, withNativeBudget(args, attemptTimeoutMs)),
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
        if (error instanceof RealMachineInTestError) {
            throw error;
        }

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
