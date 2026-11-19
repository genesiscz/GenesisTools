import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseStatusPorcelainV2Z, STATUS_PORCELAIN_ARGS, type StatusSummary } from "./porcelain";

/** What one Git read cost: the CPU of its children, its wall time and the number of Git processes. */
export interface GitReadCost {
    cpuMs: number;
    wallMs: number;
    spawns: number;
}

/** A Git read that says why it failed, never an empty answer for a failure. */
export type GitRead<T> =
    | { ok: true; value: T; cost: GitReadCost }
    | { ok: false; reason: "timeout" | "exit" | "spawn"; detail: string; cost: GitReadCost };

/** The default deadline of one Git process of the hook (the same as the hook's own `GIT_TIMEOUT_MS`). */
export const HOOK_GIT_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 64_000_000;

/**
 * The one argument list of the hook's status read. `pathspecs` are appended after `--`.
 *
 * `--no-renames` keeps the before-state lookup keyed by the path as it was when a command began. `core.preloadIndex=false`
 * stats the index on one thread: the same answer for a third of the CPU on this Mac. `--no-ahead-behind`: neither hook
 * uses upstream commit counts.
 */
export function hookStatusArgs(options: { trackedOnly?: boolean; pathspecs?: readonly string[] } = {}): string[] {
    const args = [
        "-c",
        "core.preloadIndex=false",
        ...STATUS_PORCELAIN_ARGS,
        "--no-renames",
        "--no-ahead-behind",
        ...(options.trackedOnly ? ["--untracked-files=no"] : []),
    ];

    if (options.pathspecs && options.pathspecs.length > 0) {
        args.push("--", ...options.pathspecs);
    }

    return args;
}

/** Runs one Git process synchronously. Exit 0 and 1 are answers; anything else is a failure with its reason. */
export function runGitSync(root: string, args: readonly string[], timeoutMs = HOOK_GIT_TIMEOUT_MS): GitRead<string> {
    const started = performance.now();
    let run: ReturnType<typeof Bun.spawnSync>;

    try {
        run = Bun.spawnSync(["git", "-C", root, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            timeout: timeoutMs,
            maxBuffer: MAX_BUFFER,
        });
    } catch (error) {
        return {
            ok: false,
            reason: "spawn",
            detail: String(error),
            cost: { cpuMs: 0, wallMs: performance.now() - started, spawns: 1 },
        };
    }

    const cost: GitReadCost = {
        cpuMs: Number(run.resourceUsage?.cpuTime.total ?? 0n) / 1000,
        wallMs: performance.now() - started,
        spawns: 1,
    };

    if (run.exitedDueToTimeout) {
        return { ok: false, reason: "timeout", detail: `git did not finish within ${timeoutMs} ms`, cost };
    }

    if (run.exitCode !== 0 && run.exitCode !== 1) {
        const stderr = run.stderr ? run.stderr.toString().slice(0, 400) : "";
        return { ok: false, reason: "exit", detail: `exit ${run.exitCode ?? run.signalCode}: ${stderr}`, cost };
    }

    return { ok: true, value: run.stdout ? run.stdout.toString() : "", cost };
}

/** Sync, for a hook. `Bun.spawnSync`, so the cost carries the child's CPU. */
export function readHookStatus(
    root: string,
    options: { trackedOnly?: boolean; timeoutMs?: number } = {}
): GitRead<StatusSummary> {
    const run = runGitSync(root, hookStatusArgs({ trackedOnly: options.trackedOnly }), options.timeoutMs);

    if (!run.ok) {
        return run;
    }

    return { ok: true, value: parseStatusPorcelainV2Z(run.value), cost: run.cost };
}

/** Async, for the service. Always `--no-optional-locks`, so it never writes the index. */
export async function readHookStatusAsync(
    root: string,
    options: { pathspecs?: readonly string[]; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<GitRead<StatusSummary>> {
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? HOOK_GIT_TIMEOUT_MS;
    const args = ["git", "-C", root, "--no-optional-locks", ...hookStatusArgs({ pathspecs: options.pathspecs })];
    let proc: ReturnType<typeof Bun.spawn>;

    try {
        proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs, signal: options.signal });
    } catch (error) {
        return {
            ok: false,
            reason: "spawn",
            detail: String(error),
            cost: { cpuMs: 0, wallMs: performance.now() - started, spawns: 1 },
        };
    }

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
    ]);
    const cost: GitReadCost = {
        cpuMs: Number(proc.resourceUsage()?.cpuTime.total ?? 0n) / 1000,
        wallMs: performance.now() - started,
        spawns: 1,
    };

    if (proc.signalCode !== null && performance.now() - started >= timeoutMs) {
        return { ok: false, reason: "timeout", detail: `git did not finish within ${timeoutMs} ms`, cost };
    }

    if (exitCode !== 0 && exitCode !== 1) {
        return {
            ok: false,
            reason: "exit",
            detail: `exit ${exitCode ?? proc.signalCode}: ${stderr.slice(0, 400)}`,
            cost,
        };
    }

    return { ok: true, value: parseStatusPorcelainV2Z(stdout), cost };
}

/** The worktree's Git admin folder, read from `.git` without a Git process; null when `root` is no worktree. */
export function worktreeGitDir(root: string): string | null {
    const dotGit = resolve(root, ".git");
    const stat = statSync(dotGit, { throwIfNoEntry: false });

    if (!stat) {
        return null;
    }

    if (stat.isDirectory()) {
        return dotGit;
    }

    if (!stat.isFile()) {
        return null;
    }

    const text = readFileSync(dotGit, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);

    if (!match) {
        return null;
    }

    return isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
}
