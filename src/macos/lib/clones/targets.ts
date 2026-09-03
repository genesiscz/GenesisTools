import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
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

async function spawnText(cmd: string, args: string[]): Promise<SpawnResult> {
    const proc = Bun.spawn([cmd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

export type SkipReason = "no-composer" | "not-ignored" | "not-apfs" | "missing";

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
 *  `find` (not `fd`) because every target is gitignored by design. */
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

    const args = [dir, "-name", ".git", "-prune", "-o", "-type", "d", "(", ...nameArgs, ")", "-prune", "-print"];
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
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort();
}

/** `true` = git ignores it, `false` = git tracks or would track it,
 *  `null` = the path is not inside a git repository (exit 128). */
export async function isGitIgnored(path: string): Promise<boolean | null> {
    const res = await measureItemAsync("targets.check-ignore", () =>
        spawnText("git", ["-C", dirname(path), "check-ignore", "-q", path])
    );
    if (res.status === 0) {
        return true;
    }

    if (res.status === 1) {
        return false;
    }

    log.debug({ path, status: res.status, stderr: res.stderr?.trim() }, "check-ignore: not a repository");
    return null;
}

/** A composer install tree is `vendor/` beside a composer manifest. Without
 *  this check every unrelated `vendor` directory would join the scan. */
export function hasComposerManifest(vendorDir: string): boolean {
    const parent = dirname(vendorDir);
    return existsSync(join(parent, "composer.json")) || existsSync(join(parent, "composer.lock"));
}

/** Resolve `--dir` + `--targets` into concrete scan roots. Explicitly named
 *  kinds bypass the gitignore filter; the composer rule always applies. */
export async function expandTargets(args: { dirs: string[]; targets: string[] }): Promise<ExpandTargetsResult> {
    const end = clonesProfile.start("expand");
    const ignoredMode = args.targets.includes("gitignored");
    const explicit = new Set(args.targets.filter((t) => t !== "gitignored"));
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
        (found) => !explicit.has(basename(found)) && !(basename(found) === "vendor" && !hasComposerManifest(found))
    );
    const ignoredByPath = await concurrentMap({
        items: needsIgnoreCheck,
        fn: (found) => isGitIgnored(found),
        concurrency: SPAWN_CONCURRENCY,
        onError: (found, err) => log.warn({ err, path: found }, "check-ignore failed"),
    });

    for (const found of candidates) {
        const name = basename(found);
        if (name === "vendor" && !hasComposerManifest(found)) {
            skipped.push({ path: found, reason: "no-composer" });
            continue;
        }

        if (!explicit.has(name) && ignoredByPath.get(found) === false) {
            skipped.push({ path: found, reason: "not-ignored" });
            continue;
        }

        roots.push(found);
    }

    const elapsedMs = Math.round(end());
    log.info(
        { dirs: args.dirs, targets: args.targets, roots: roots.length, skipped: skipped.length, elapsedMs },
        "targets expanded"
    );
    return { roots, skipped };
}
