import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentSessionIds } from "@genesiscz/utils/agent/host";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { installedGenesisAppLauncher } from "@genesiscz/utils/macos/genesis-app";
import { captureNativeSources, nativeNeedsBuild, recordNativeBuild } from "./native-build";

const GT_ROOT = join(import.meta.dir, "..", "..", "..");
const BINARY_PATH = join(GT_ROOT, "native", "ax-tool", ".build", "release", "ax-tool");
const SWIFT_SOURCE = join(GT_ROOT, "native", "ax-tool");

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
    logger.debug({ command: args[0], timeoutMs }, "running native control command");
    let binary: string;
    try {
        binary = boundary.ensureBinary();
    } catch (error) {
        logger.error({ error }, "native control build unavailable");
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const r = boundary.spawn({ binary, args, timeoutMs, maxBufferBytes: AX_STDOUT_BUDGET_BYTES });

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
            parsed.error ??= `native command terminated by ${r.signal}; the action may have partially completed; no retry was attempted`;
        } else if (r.status !== 0) {
            parsed.ok = false;
            parsed.error ??= `native command exited ${r.status}`;
        }

        logger.debug({ command: args[0], ok: parsed.ok, error: parsed.error }, "native control completed");
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
export function runAx(args: string[], timeoutMs = 10_000): AxResult {
    const mutating = [
        "act",
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
    const nativeArgs = !cursorFeedbackEnabled && mutating ? [...args, "--no-cursor"] : args;
    return runAxWithBoundary({ args: nativeArgs, timeoutMs, boundary: DEFAULT_AX_RUN_BOUNDARY });
}

export function getBinaryPath(): string {
    return BINARY_PATH;
}
