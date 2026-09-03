import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { minimatch } from "minimatch";
import { clonesProfile, measureItemAsync } from "./profile";

const log = logger.child({ component: "clones:targets" });

/** `find` and `git check-ignore` are spawned this many at a time. A fleet of
 *  41 worktrees ran its finds one after another at ~0.45 s each (18.6 s of a
 *  67 s plan); eight in flight brings that under 3 s on a machine already busy. */
const SPAWN_CONCURRENCY = 8;

interface SpawnResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

async function spawnText(cmd: string, args: string[], stdin?: string): Promise<SpawnResult> {
    const proc = Bun.spawn([cmd, ...args], {
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const status = await proc.exited;
    return { status, stdout, stderr };
}

/** Values `--targets` accepts. `gitignored` is the default when the flag is
 *  omitted: it means "the well-known install dirs, but only where git agrees
 *  they are ignored (or there is no repo to ask)". */
export const TARGET_KIND_VALUES = ["gitignored", "node_modules", "vendor", "Pods", ".cxx"] as const;

export type TargetKind = (typeof TARGET_KIND_VALUES)[number];

/** Directory names that hold installed dependencies. */
export const INSTALL_DIR_NAMES = ["node_modules", "vendor", "Pods", ".cxx"] as const;

export type SkipReason = "no-composer" | "not-ignored" | "check-ignore-failed" | "not-apfs" | "missing";

export interface SkippedRoot {
    path: string;
    reason: SkipReason;
}

export interface ExpandTargetsResult {
    roots: string[];
    skipped: SkippedRoot[];
}

/** Directories under `dir` whose basename is in `names`, pruned at the first
 *  match so a nested `node_modules` never becomes a second root. `.git` is
 *  pruned first — its contents are content-addressed and never reclaimable.
 *  `find` (not `fd`) because every target is gitignored by design.
 *  `-print0` because a directory name may contain a newline: splitting on one
 *  turned a single such path into two bogus roots and dropped the real one. */
export async function findNamedDirs(dir: string, names: readonly string[]): Promise<string[]> {
    if (names.length === 0) {
        return [];
    }

    const nameArgs: string[] = [];
    names.forEach((n, i) => {
        if (i > 0) {
            nameArgs.push("-o");
        }

        nameArgs.push("-name", n);
    });

    const args = [dir, "-name", ".git", "-prune", "-o", "-type", "d", "(", ...nameArgs, ")", "-prune", "-print0"];
    let res: SpawnResult;
    try {
        res = await measureItemAsync("targets.find", () => spawnText("find", args));
    } catch (err) {
        log.warn({ err, dir }, "find failed");
        return [];
    }

    if (res.stderr.trim().length > 0) {
        log.debug({ dir, stderr: res.stderr.trim() }, "find reported unreadable paths");
    }

    return res.stdout
        .split("\0")
        .filter((path) => path.length > 0)
        .sort();
}

/** The nearest ancestor of `dir` (itself included) that holds a `.git` entry,
 *  or null when there is none. A worktree's `.git` is a file, a main
 *  checkout's is a directory; either marks a repository. Memoised per
 *  directory so a fleet of candidates under one worktree costs one walk. */
function nearestGitRoot(dir: string, memo: Map<string, string | null>): string | null {
    const chain: string[] = [];
    let current = dir;
    for (;;) {
        const hit = memo.get(current);
        if (hit !== undefined) {
            for (const d of chain) {
                memo.set(d, hit);
            }

            return hit;
        }

        chain.push(current);
        if (existsSync(join(current, ".git"))) {
            for (const d of chain) {
                memo.set(d, current);
            }

            return current;
        }

        const parent = dirname(current);
        if (parent === current) {
            for (const d of chain) {
                memo.set(d, null);
            }

            return null;
        }

        current = parent;
    }
}

/** One `git check-ignore` for every candidate of one repository. Returns
 *  `true`/`false` per path, or `null` when `repoDir` is not inside a git
 *  repository (git's own exit 128 saying so). Any other outcome throws, so a
 *  failure never reads as "ignored" and never widens what `apply` may rewrite;
 *  the caller skips the whole batch.
 *
 *  `-z` on both sides: input paths are NUL-separated (a path may contain a
 *  newline) and output arrives as four NUL-terminated fields per path
 *  (source, linenum, pattern, pathname) with an empty pattern for a path no
 *  rule matched. `-n` is what makes git report those too. */
export async function checkIgnoreBatch(repoDir: string, paths: string[]): Promise<Map<string, boolean> | null> {
    if (paths.length === 0) {
        return new Map();
    }

    const res = await measureItemAsync("targets.check-ignore", () =>
        spawnText("git", ["-C", repoDir, "check-ignore", "-z", "-v", "-n", "--stdin"], `${paths.join("\0")}\0`)
    );
    const stderr = res.stderr?.trim() ?? "";
    if (res.status === 128 && stderr.includes("not a git repository")) {
        log.debug({ repoDir, stderr }, "check-ignore: not a repository");
        return null;
    }

    // 0 = at least one path is ignored, 1 = none of them are. Both are answers.
    if (res.status !== 0 && res.status !== 1) {
        throw new Error(`git check-ignore failed for ${repoDir} (status ${res.status}): ${stderr}`);
    }

    const fields = res.stdout.split("\0");
    const out = new Map<string, boolean>();
    for (let i = 0; i + 3 < fields.length; i += 4) {
        out.set(fields[i + 3], fields[i + 2].length > 0);
    }

    return out;
}

/** `true` = git ignores it, `false` = git tracks or would track it,
 *  `null` = the path is not inside a git repository. Any other outcome throws. */
export async function isGitIgnored(path: string): Promise<boolean | null> {
    const answers = await checkIgnoreBatch(dirname(path), [path]);
    if (answers === null) {
        return null;
    }

    const answer = answers.get(path);
    if (answer === undefined) {
        throw new Error(`git check-ignore returned no answer for ${path}`);
    }

    return answer;
}

/** A composer install tree is `vendor/` beside a composer manifest. Without
 *  this check every unrelated `vendor` directory would join the scan. */
export function hasComposerManifest(vendorDir: string): boolean {
    const parent = dirname(vendorDir);
    return existsSync(join(parent, "composer.json")) || existsSync(join(parent, "composer.lock"));
}

/** A `--targets` value is either a literal directory name (`node_modules`) or
 *  a `find -name` pattern (`build-*`), and the flag help documents both. The
 *  pattern form has to match the same way, or every root a pattern finds is
 *  forced through the gitignore filter that a named kind bypasses. */
function matchesExplicit(name: string, explicit: readonly string[]): boolean {
    return explicit.some((value) => value === name || minimatch(name, value, { dot: true, nocomment: true }));
}

/** Resolve `--dir` + `--targets` into concrete scan roots. Explicitly named
 *  kinds (and explicit `find -name` patterns) bypass the gitignore filter; the
 *  composer rule always applies. */
export async function expandTargets(args: { dirs: string[]; targets: string[] }): Promise<ExpandTargetsResult> {
    const end = clonesProfile.start("expand");
    const ignoredMode = args.targets.includes("gitignored");
    const explicit = [...new Set(args.targets.filter((t) => t !== "gitignored"))];
    const names = [...new Set([...explicit, ...(ignoredMode ? INSTALL_DIR_NAMES : [])])];
    const roots: string[] = [];
    const skipped: SkippedRoot[] = [];
    const seen = new Set<string>();

    const foundByDir = await concurrentMap({
        items: args.dirs,
        fn: (dir) => findNamedDirs(dir, names),
        concurrency: SPAWN_CONCURRENCY,
        onError: (dir, err) => log.warn({ err, dir }, "find failed"),
    });
    const candidates: string[] = [];
    for (const dir of args.dirs) {
        for (const found of foundByDir.get(dir) ?? []) {
            if (!seen.has(found)) {
                seen.add(found);
                candidates.push(found);
            }
        }
    }

    const needsIgnoreCheck = candidates.filter(
        (found) =>
            !matchesExplicit(basename(found), explicit) &&
            !(basename(found) === "vendor" && !hasComposerManifest(found))
    );

    // One `git check-ignore` per repository instead of one per candidate: a
    // 41-worktree fleet spent 100-300 git spawns on this phase.
    const gitRootMemo = new Map<string, string | null>();
    const byRepo = new Map<string, string[]>();
    for (const found of needsIgnoreCheck) {
        const repo = nearestGitRoot(dirname(found), gitRootMemo) ?? dirname(found);
        const list = byRepo.get(repo);
        if (list) {
            list.push(found);
        } else {
            byRepo.set(repo, [found]);
        }
    }

    const batches = await concurrentMap({
        items: [...byRepo.keys()],
        fn: (repo) => checkIgnoreBatch(repo, byRepo.get(repo) ?? []),
        concurrency: SPAWN_CONCURRENCY,
        onError: (repo, err) => log.warn({ err, repo }, "check-ignore failed"),
    });
    // A batch that threw has no entry, so every candidate of that repository
    // stays unknown and is skipped — the fail-closed contract, per batch.
    const ignoredByPath = new Map<string, boolean | null>();
    for (const [repo, paths] of byRepo) {
        if (!batches.has(repo)) {
            continue;
        }

        const answers = batches.get(repo);
        for (const path of paths) {
            if (answers === null || answers === undefined) {
                ignoredByPath.set(path, null);
                continue;
            }

            const answer = answers.get(path);
            if (answer !== undefined) {
                ignoredByPath.set(path, answer);
            }
        }
    }

    for (const found of candidates) {
        const name = basename(found);
        if (name === "vendor" && !hasComposerManifest(found)) {
            skipped.push({ path: found, reason: "no-composer" });
            continue;
        }

        if (!matchesExplicit(name, explicit)) {
            // No entry means the check itself failed (logged by onError). A
            // root whose status is unknown is skipped, never scanned.
            if (!ignoredByPath.has(found)) {
                skipped.push({ path: found, reason: "check-ignore-failed" });
                continue;
            }

            if (ignoredByPath.get(found) === false) {
                skipped.push({ path: found, reason: "not-ignored" });
                continue;
            }
        }

        roots.push(found);
    }

    const elapsedMs = Math.round(end());
    log.info(
        {
            dirs: args.dirs,
            targets: args.targets,
            repos: byRepo.size,
            roots: roots.length,
            skipped: skipped.length,
            elapsedMs,
        },
        "targets expanded"
    );
    return { roots, skipped };
}
