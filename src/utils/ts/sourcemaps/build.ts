import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, readFile, rename, rm, stat, symlink, utimes } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { canonicalDir } from "@genesiscz/utils/fs/canonical";
import { measureTree } from "@genesiscz/utils/fs/disk-usage";
import { parseWorktreeListZ, WORKTREE_LIST_ARGS, type WorktreeEntry } from "@genesiscz/utils/git/porcelain";
import { logger } from "@genesiscz/utils/logger";
import { batchCwd, listPsRows } from "@genesiscz/utils/process/ps";
import { profiler } from "@genesiscz/utils/profile";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage";
import type { Subprocess } from "bun";
import type { CacheEntry, SourcemapCache } from "./cache.ts";

const prof = profiler.scope("sourcemaps");
/** How long a build waits for another build in the same worktree to finish. */
const BUILD_LOCK_TIMEOUT_MS = 30 * 60_000;

const { log } = logger.scoped("ts:sourcemaps:build");

/**
 * What this process's builds hold: the managed worktrees they ran in, the build commands still running, and the
 * builds that hold a worktree lock. A command calls `releaseBuildWorktrees` when it ends, so a worktree with its
 * installed dependencies (gigabytes for a large app) does not outlive the command.
 */
const held = {
    worktrees: new Map<string, SourcemapCache>(),
    processes: new Set<Subprocess>(),
    /** Each settles once its build has ended and released the worktree lock. */
    builds: new Set<Promise<void>>(),
    stopping: false,
};

/** Why `removeBuildWorktree` removed a worktree or left it in place. */
export type WorktreeOutcome = "removed" | "absent" | "recent" | "busy" | "locked" | "in-use" | "changed" | "failed";

export interface WorktreeRemoval {
    worktree: string;
    outcome: WorktreeOutcome;
    /** Bytes freed: on APFS the bytes no clone shares (what the disk gets back), elsewhere the allocated size. */
    bytes: number;
    /** Removed only: its size on disk as `du` counts it, blocks shared with clones (a package manager's cache) included. */
    diskBytes?: number;
    /** Why it was kept: the lock reason, the processes inside it, its tracked changes, the git error. */
    detail?: string;
}

export interface BuildAtCommitOptions {
    cache: SourcemapCache;
    /** The caller's checkout; the build runs in a separate worktree of it, never in the checkout itself. */
    repo: string;
    commit: string;
    /** Shell command run in the worktree root, e.g. `bun install --frozen-lockfile && cd web && bun run build`. */
    buildCmd: string;
    /** The build output folder, relative to the worktree root (the folder that holds the JS and `.map` files). */
    outputDir: string;
    /** Worktree to build in. Default: one managed worktree per project under the cache. */
    worktree?: string;
    /** Untracked files of `repo` to symlink into the worktree before building (registry config, `.env`). */
    links?: string[];
    /** Extra environment for the build command. */
    env?: Record<string, string>;
    signal?: AbortSignal;
    /** Rebuild even when the cache already holds this commit + command. */
    refresh?: boolean;
    onLine?(line: string): void;
}

export interface BuildResult {
    entry: CacheEntry;
    dir: string;
    commit: string;
    reused: boolean;
    durationMs: number;
}

/** Runs git in `cwd` and returns trimmed stdout; throws with stderr on a non-zero exit. */
export async function git(cwd: string, args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    }

    return stdout.trim();
}

/** Full commit sha of a ref in `repo`. */
export function resolveCommit(repo: string, ref: string): Promise<string> {
    return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

/**
 * The cache id of a build: commit plus a hash of the command, the output folder and `inputs` (the extra
 * environment and linked files, see `buildInputs`). A build with no extra inputs keeps the id it always had.
 */
export function buildId(commit: string, buildCmd: string, outputDir: string, inputs = ""): string {
    const recipe = createHash("sha1")
        .update(`${buildCmd}\n${outputDir}${inputs ? `\n${inputs}` : ""}`)
        .digest("hex")
        .slice(0, 8);
    return `build-${commit.slice(0, 12)}-${recipe}`;
}

/**
 * The parts of a build recipe beyond the command: every extra env pair, and every linked file with a hash of its
 * content (a `.env` is inlined into the bundle), so changing either one makes a new build instead of reusing the old.
 */
export async function buildInputs(options: {
    repo: string;
    env?: Record<string, string>;
    links?: string[];
}): Promise<string> {
    const parts = Object.entries(options.env ?? {})
        .sort(([a], [z]) => a.localeCompare(z))
        .map(([key, value]) => `env ${key}=${value}`);
    for (const link of [...(options.links ?? [])].sort()) {
        const content = await readFile(join(options.repo, link)).catch(() => null);
        parts.push(`link ${link}${content ? ` ${createHash("sha1").update(content).digest("hex").slice(0, 12)}` : ""}`);
    }

    return parts.join("\n");
}

async function exists(path: string): Promise<boolean> {
    return lstat(path).then(
        () => true,
        () => false
    );
}

/** The worktree a project's builds share when the caller names none. */
export function managedWorktree(cache: SourcemapCache): string {
    return join(cache.dir, "worktree");
}

/** One build at a time holds this lock on `worktree`, across processes; removing the worktree takes it too. */
function worktreeLockPath(cache: SourcemapCache, worktree: string): string {
    return join(cache.dir, `.worktree-${createHash("sha1").update(worktree).digest("hex").slice(0, 8)}.lock`);
}

async function prepareWorktree(options: { repo: string; worktree: string; commit: string }): Promise<void> {
    if (!(await exists(options.worktree))) {
        await mkdir(dirname(options.worktree), { recursive: true });
        log.info({ worktree: options.worktree, commit: options.commit }, "creating build worktree");
        await git(options.repo, ["worktree", "add", "--detach", options.worktree, options.commit]);
        return;
    }

    const status = await git(options.worktree, ["status", "--porcelain", "--untracked-files=no"]);
    if (status) {
        throw new Error(
            `build worktree ${options.worktree} has tracked changes; it is a scratch tree, inspect and reset it yourself:\n${status}`
        );
    }

    await git(options.worktree, ["checkout", "--detach", options.commit]);
}

/** The build itself; the caller holds the worktree lock. */
async function buildLocked(input: {
    options: BuildAtCommitOptions;
    worktree: string;
    commit: string;
    id: string;
    dir: string;
}): Promise<BuildResult> {
    const { options, worktree, commit, id, dir } = input;
    await prepareWorktree({ repo: options.repo, worktree, commit });
    // `cache prune` removes a worktree idle for an hour; reusing one changes no folder entry, so mark it used.
    const now = new Date();
    await utimes(worktree, now, now);
    for (const link of options.links ?? []) {
        const target = join(worktree, link);
        if (!(await exists(target))) {
            await mkdir(dirname(target), { recursive: true });
            await symlink(join(options.repo, link), target);
        }
    }

    await mkdir(dir, { recursive: true });
    const logPath = join(dir, ".build.log");
    const logFile = createWriteStream(logPath);
    const started = performance.now();
    if (held.stopping) {
        throw new Error(`build of ${commit.slice(0, 12)} not started: the command is stopping its builds`);
    }

    log.info({ commit, worktree, buildCmd: options.buildCmd }, "building");
    const proc = Bun.spawn(["sh", "-c", options.buildCmd], {
        cwd: worktree,
        env: { ...process.env, ...options.env },
        stdout: "pipe",
        stderr: "pipe",
    });
    held.processes.add(proc);
    const abort = (): void => proc.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        const decoder = new TextDecoder();
        let pending = "";
        for await (const chunk of stream) {
            const text = decoder.decode(chunk, { stream: true });
            logFile.write(text);
            pending += text;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
                options.onLine?.(line);
            }
        }
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const code = await proc.exited;
    held.processes.delete(proc);
    options.signal?.removeEventListener("abort", abort);
    logFile.end();
    if (code !== 0) {
        throw new Error(`build command exited ${code} at ${commit.slice(0, 12)}; log: ${logPath}`);
    }

    const output = join(worktree, options.outputDir);
    if (!(await stat(output).catch(() => null))?.isDirectory()) {
        throw new Error(`build finished but ${output} is not a folder; check --output`);
    }

    // Copy aside, then swap: a refresh must not merge into the old output, or a chunk the new build dropped
    // stays beside the current ones.
    const files = join(dir, "files");
    const staging = `${files}.staging`;
    await rm(staging, { recursive: true, force: true });
    await cp(output, staging, { recursive: true });
    await rm(files, { recursive: true, force: true });
    await rename(staging, files);
    const entry = await options.cache.commit({
        id,
        kind: "build",
        label: `${commit.slice(0, 12)} ${options.outputDir}`,
        origin: { repo: options.repo, commit, buildCmd: options.buildCmd, outputDir: options.outputDir },
    });
    return { entry, dir, commit, reused: false, durationMs: Math.round(performance.now() - started) };
}

/**
 * Builds `commit` with the caller's own command and keeps the output (with its `.map` files) in the cache.
 * GenesisTools knows nothing about the project: the command, output folder, extra files and environment
 * all come from the caller. A build already cached for the same commit and recipe is reused.
 */
export async function buildAtCommit(options: BuildAtCommitOptions): Promise<BuildResult> {
    const stopProfile = prof.start("build");
    try {
        const commit = await resolveCommit(options.repo, options.commit);
        const id = buildId(commit, options.buildCmd, options.outputDir, await buildInputs(options));
        const dir = options.cache.entryDir(id);
        const existing = await options.cache.get(id);
        if (existing && !options.refresh) {
            await options.cache.touch(id);
            return { entry: existing, dir, commit, reused: true, durationMs: 0 };
        }

        const worktree = options.worktree ?? managedWorktree(options.cache);
        await mkdir(options.cache.dir, { recursive: true });
        let ended: (() => void) | undefined;
        try {
            // One build at a time per worktree, across processes: a checkout in the middle of another build would
            // cache one commit's output under the other commit's id.
            return await withFileLock(
                worktreeLockPath(options.cache, worktree),
                async () => {
                    // Whoever held the lock may have just built this very recipe.
                    const built = options.refresh ? null : await options.cache.get(id);
                    if (built) {
                        await options.cache.touch(id);
                        return { entry: built, dir, commit, reused: true, durationMs: 0 };
                    }

                    // A worktree the caller named is theirs; only the managed one is removed when the command ends.
                    if (!options.worktree) {
                        held.worktrees.set(worktree, options.cache);
                    }

                    const { promise, resolve } = Promise.withResolvers<void>();
                    held.builds.add(promise);
                    ended = () => {
                        held.builds.delete(promise);
                        resolve();
                    };
                    return buildLocked({ options, worktree, commit, id, dir });
                },
                BUILD_LOCK_TIMEOUT_MS
            );
        } finally {
            // Only now is the lock released, so a release that waits for this build can take it.
            ended?.();
        }
    } finally {
        stopProfile();
    }
}

/**
 * Removes the managed worktrees this process built in, each through `removeBuildWorktree`, so a command leaves no
 * installed dependencies behind. It waits until every build has released its worktree. With `stop` (the command was
 * interrupted) it first ends the running build commands and refuses to start new ones until it returns.
 */
export async function releaseBuildWorktrees(options: { stop?: boolean } = {}): Promise<WorktreeRemoval[]> {
    held.stopping = options.stop === true;
    try {
        if (options.stop) {
            for (const proc of held.processes) {
                proc.kill();
            }
        }

        await Promise.all(held.builds);
        const removals: WorktreeRemoval[] = [];
        for (const [worktree, cache] of held.worktrees) {
            removals.push(await removeBuildWorktree({ cache, worktree }));
        }

        held.worktrees.clear();
        return removals;
    } finally {
        held.stopping = false;
    }
}

/**
 * Removes a build worktree with `git worktree remove`, never by deleting files itself. It is kept while it may still
 * be wanted: a build runs in it (the build lock is held), it is locked with `git worktree lock`, a process has its
 * working directory inside it, or it has tracked changes. With `idleMs` it is also kept when used more recently.
 */
export async function removeBuildWorktree(options: {
    cache: SourcemapCache;
    worktree: string;
    idleMs?: number;
}): Promise<WorktreeRemoval> {
    const { worktree } = options;
    const folder = await stat(worktree).catch(() => null);
    if (!folder?.isDirectory()) {
        return { worktree, outcome: "absent", bytes: 0 };
    }

    if (options.idleMs !== undefined && Date.now() - folder.mtimeMs < options.idleMs) {
        return { worktree, outcome: "recent", bytes: 0 };
    }

    try {
        // No waiting: a held lock means a build is running in it right now.
        return await withFileLock(worktreeLockPath(options.cache, worktree), () => removeUnusedWorktree(worktree), 0);
    } catch (error) {
        if (error instanceof LockTimeoutError) {
            return { worktree, outcome: "busy", bytes: 0, detail: "a build is running in it" };
        }

        // A command's own error must not be replaced by its cleanup's: report the worktree as kept instead.
        log.warn({ err: error, worktree }, "could not check the build worktree; left in place");
        return {
            worktree,
            outcome: "failed",
            bytes: 0,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

/** The checks and the removal that need the build lock; see `removeBuildWorktree`. */
async function removeUnusedWorktree(worktree: string): Promise<WorktreeRemoval> {
    const kept = (outcome: WorktreeOutcome, detail: string): WorktreeRemoval => {
        log.info({ worktree, outcome, detail }, "kept build worktree");
        return { worktree, outcome, bytes: 0, detail };
    };
    const real = canonicalDir(worktree);
    let commonDir: string;
    let listed: WorktreeEntry | undefined;
    try {
        commonDir = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        listed = parseWorktreeListZ(await git(commonDir, [...WORKTREE_LIST_ARGS])).find(
            (entry) => canonicalDir(entry.path) === real
        );
    } catch (error) {
        return kept("failed", `git cannot read it: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!listed) {
        return kept("failed", "git does not list it as a worktree");
    }

    if (listed.locked !== null) {
        return kept("locked", `locked with git worktree lock: ${listed.locked}`);
    }

    const rows = await listPsRows();
    if (rows.length === 0) {
        return kept("in-use", "the process list is unreadable, so a process may work in it");
    }

    const cwds = batchCwd(rows.map((row) => row.pid));
    // The kernel reports a working directory already resolved; canonicalizing 1,300 of them cost 0.6 to 5 s here.
    const inside = rows.filter((row) => {
        const cwd = cwds.get(row.pid);
        return cwd !== undefined && (cwd === real || cwd.startsWith(real + sep));
    });
    if (inside.length > 0) {
        return kept(
            "in-use",
            `a process works in it: ${inside
                .slice(0, 3)
                .map((row) => `${row.pid} ${row.command.slice(0, 60)}`)
                .join(", ")}`
        );
    }

    const changes = await git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
    if (changes) {
        return kept("changed", `it has tracked changes:\n${changes}`);
    }

    const usage = measureTree(worktree, { exact: false });
    try {
        // --force lets untracked build output and --link symlinks go with it; one --force still refuses a locked tree.
        await git(commonDir, ["worktree", "remove", "--force", worktree]);
    } catch (error) {
        return kept("failed", error instanceof Error ? error.message : String(error));
    }

    const bytes = usage.private ?? usage.allocated;
    log.info({ worktree, bytes, diskBytes: usage.allocated, files: usage.fileCount }, "removed build worktree");
    return { worktree, outcome: "removed", bytes, diskBytes: usage.allocated };
}

/** The folder of a build entry that holds the build output. */
export function buildFilesDir(cache: SourcemapCache, id: string): string {
    return join(cache.entryDir(id), "files");
}
