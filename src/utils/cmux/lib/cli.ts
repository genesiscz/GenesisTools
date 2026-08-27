import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface CmuxRunResult {
    code: number;
    stdout: string;
    stderr: string;
    /** True when the process was killed by the caller-supplied timeoutMs. */
    timedOut?: boolean;
}

const CMUX_FALLBACK_DIRS = [".local/bin", ".bun/bin", ".cargo/bin"];
const CMUX_SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

let cachedCmuxPath: string | null = null;

function resolveCmuxPath(): string {
    if (cachedCmuxPath) {
        return cachedCmuxPath;
    }

    // Explicit PATH, not the implicit one: Bun.which reads the PATH captured at
    // process start and ignores later mutations of process.env.PATH (verified).
    // So a PATH set by the caller — or by a test installing a stand-in — was
    // silently ignored.
    const fromPath = Bun.which("cmux", { PATH: env.getProcessEnv().PATH ?? "" });
    if (fromPath) {
        cachedCmuxPath = fromPath;
        return fromPath;
    }

    const home = homedir();
    const candidates = [
        ...CMUX_FALLBACK_DIRS.map((dir) => join(home, dir, "cmux")),
        ...CMUX_SYSTEM_DIRS.map((dir) => join(dir, "cmux")),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            logger.debug({ candidate }, "[cmux] resolved via fallback dir (not on PATH)");
            cachedCmuxPath = candidate;
            return candidate;
        }
    }

    const searched = ["PATH", ...candidates].join(", ");
    throw new Error(`cmux is not installed (or not found in ${searched})`);
}

/**
 * Upper bound on every cmux call that does not name its own.
 *
 * The escalation used to be opt-in, and only one of 38 call sites opted in — so
 * a wedged cmux hung the other 37 forever, on the branch whose entire subject is
 * cmux livelock. CLAUDE.md: "A new safety parameter leaves every existing caller
 * unsafe. Prefer inverting the default so the DANGEROUS behavior is the opt-in."
 * Generous on purpose: no healthy local socket call comes close.
 */
export const DEFAULT_CMUX_TIMEOUT_MS = 30_000;

/** Bounded unless the caller explicitly passes `timeoutMs: null`. */
export type CmuxTimeoutOpt = { timeoutMs?: number | null };

export async function runCmux(args: string[], opts: { json?: boolean } & CmuxTimeoutOpt = {}): Promise<CmuxRunResult> {
    // null is the explicit opt-out; undefined means "nobody thought about it",
    // which is exactly the case that must be bounded.
    const timeoutMs = opts.timeoutMs === null ? undefined : (opts.timeoutMs ?? DEFAULT_CMUX_TIMEOUT_MS);
    const finalArgs = opts.json ? ["--json", ...args] : args;
    const cmuxPath = resolveCmuxPath();
    logger.debug({ args: finalArgs, cmuxPath }, "[cmux] spawn");
    const proc = Bun.spawn([cmuxPath, ...finalArgs], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // Resolves once the child has been SIGKILLed, so the reads can be abandoned.
    let abandon: Promise<void> | undefined;
    if (timeoutMs) {
        let giveUp: () => void = () => {};
        abandon = new Promise<void>((resolve) => {
            giveUp = resolve;
        });
        timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
            // SIGTERM can be ignored, and proc.exited only settles on a real exit —
            // escalate so the timeout is an upper bound, not a suggestion.
            killTimer = setTimeout(() => {
                proc.kill("SIGKILL");
                giveUp();
            }, 2000);
        }, timeoutMs);
    }

    let stdout: string;
    let stderr: string;
    let exitCode: number | null;

    try {
        const collected = Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]).then(([o, e, c]) => ({ abandoned: false, o, e, c }) as const);

        // Killing the child is not enough to unblock these reads: a grandchild
        // inherits the pipe, so `sh -c "sleep 30"` keeps the write end open long
        // after the shell is gone and the Response never settles. Without this
        // race the timeout killed the process and then waited for it anyway —
        // measured at 30.2 s against a 300 ms timeout.
        const outcome = await (abandon
            ? Promise.race([collected, abandon.then(() => ({ abandoned: true, o: "", e: "", c: null }) as const)])
            : collected);

        stdout = outcome.o;
        stderr = outcome.e;
        exitCode = outcome.c;
    } finally {
        clearTimeout(timer);
        clearTimeout(killTimer);
    }

    if (timedOut) {
        return {
            code: exitCode ?? -1,
            stdout,
            stderr: stderr || `cmux ${args[0]} timed out after ${timeoutMs} ms`,
            timedOut: true,
        };
    }

    if (exitCode === null) {
        throw new Error(`cmux terminated by signal before exiting`);
    }

    return { code: exitCode, stdout, stderr };
}

export async function runCmuxJSON<T = unknown>(args: string[], opts: CmuxTimeoutOpt = {}): Promise<T> {
    const result = await runCmux(args, { json: true, ...opts });
    if (result.code !== 0) {
        const message = `cmux ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`;
        logger.error({ args, code: result.code, stderr: result.stderr }, "[cmux] command failed");
        throw new Error(message);
    }
    try {
        return SafeJSON.parse(result.stdout, { strict: true }) as T;
    } catch (error) {
        logger.error({ args, stdout: result.stdout.slice(0, 500), error }, "[cmux] non-JSON response on --json call");
        throw new Error(`cmux ${args.join(" ")} returned non-JSON output:\n${result.stdout.slice(0, 500)}\n(${error})`);
    }
}

export async function runCmuxOk(args: string[], opts: CmuxTimeoutOpt = {}): Promise<CmuxRunResult> {
    const result = await runCmux(args, opts);
    if (result.code !== 0) {
        logger.error({ args, code: result.code, stderr: result.stderr }, "[cmux] command failed");
        throw new Error(`cmux ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result;
}
