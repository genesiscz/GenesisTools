import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { clonesProfile, measureItem } from "./profile";

const log = logger.child({ component: "clones:targets" });

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
export function findNamedDirs(dir: string, names: readonly string[]): string[] {
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
    const res = measureItem("targets.find", () =>
        spawnSync("find", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    );
    if (res.error) {
        log.warn({ err: res.error, dir }, "find failed");
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
export function isGitIgnored(path: string): boolean | null {
    const res = measureItem("targets.check-ignore", () =>
        spawnSync("git", ["-C", dirname(path), "check-ignore", "-q", path], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        })
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
export function expandTargets(args: { dirs: string[]; targets: string[] }): ExpandTargetsResult {
    const end = clonesProfile.start("expand");
    const ignoredMode = args.targets.includes("gitignored");
    const explicit = new Set(args.targets.filter((t) => t !== "gitignored"));
    const names = [...new Set([...explicit, ...(ignoredMode ? INSTALL_DIR_NAMES : [])])];
    const roots: string[] = [];
    const skipped: SkippedRoot[] = [];
    const seen = new Set<string>();

    for (const dir of args.dirs) {
        for (const found of findNamedDirs(dir, names)) {
            if (seen.has(found)) {
                continue;
            }

            seen.add(found);
            const name = basename(found);
            if (name === "vendor" && !hasComposerManifest(found)) {
                skipped.push({ path: found, reason: "no-composer" });
                continue;
            }

            if (!explicit.has(name) && isGitIgnored(found) === false) {
                skipped.push({ path: found, reason: "not-ignored" });
                continue;
            }

            roots.push(found);
        }
    }

    const elapsedMs = Math.round(end());
    log.info(
        { dirs: args.dirs, targets: args.targets, roots: roots.length, skipped: skipped.length, elapsedMs },
        "targets expanded"
    );
    return { roots, skipped };
}
