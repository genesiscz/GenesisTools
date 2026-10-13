import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, readFile, rename, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { withFileLock } from "@genesiscz/utils/storage";
import type { CacheEntry, SourcemapCache } from "./cache.ts";

const prof = profiler.scope("sourcemaps");
/** How long a build waits for another build in the same worktree to finish. */
const BUILD_LOCK_TIMEOUT_MS = 30 * 60_000;

const { log } = logger.scoped("ts:sourcemaps:build");

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
    log.info({ commit, worktree, buildCmd: options.buildCmd }, "building");
    const proc = Bun.spawn(["sh", "-c", options.buildCmd], {
        cwd: worktree,
        env: { ...process.env, ...options.env },
        stdout: "pipe",
        stderr: "pipe",
    });
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

        const worktree = options.worktree ?? join(options.cache.dir, "worktree");
        await mkdir(options.cache.dir, { recursive: true });
        const lockName = `.worktree-${createHash("sha1").update(worktree).digest("hex").slice(0, 8)}.lock`;
        // One build at a time per worktree, across processes: a checkout in the middle of another build would cache
        // one commit's output under the other commit's id.
        return await withFileLock(
            join(options.cache.dir, lockName),
            async () => {
                // Whoever held the lock may have just built this very recipe.
                const built = options.refresh ? null : await options.cache.get(id);
                if (built) {
                    await options.cache.touch(id);
                    return { entry: built, dir, commit, reused: true, durationMs: 0 };
                }

                return buildLocked({ options, worktree, commit, id, dir });
            },
            BUILD_LOCK_TIMEOUT_MS
        );
    } finally {
        stopProfile();
    }
}

/** The folder of a build entry that holds the build output. */
export function buildFilesDir(cache: SourcemapCache, id: string): string {
    return join(cache.entryDir(id), "files");
}
