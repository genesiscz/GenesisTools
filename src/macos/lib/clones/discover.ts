import { existsSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { listWorktrees } from "@genesiscz/utils/git/worktree";
import { logger } from "@genesiscz/utils/logger";
import { getFsType } from "@genesiscz/utils/macos/apfs";
import { clonesProfile } from "./profile";
import { expandTargets, type SkippedRoot } from "./targets";

const log = logger.child({ component: "clones:discover" });

export class RepoNotFoundError extends Error {
    readonly candidates: string[];

    constructor(message: string, candidates: string[]) {
        super(message);
        this.name = "RepoNotFoundError";
        this.candidates = candidates;
    }
}

export interface DiscoverArgs {
    dirs: string[];
    worktreesOf?: string;
    targets: string[];
}

export interface DiscoverResult {
    searchDirs: string[];
    roots: string[];
    skipped: SkippedRoot[];
}

/** A worktree's `.git` is a FILE, a main checkout's is a directory — existence
 *  of either marks a git root. */
function isGitRoot(dir: string): boolean {
    return existsSync(join(dir, ".git"));
}

function gitChildren(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && isGitRoot(join(dir, e.name)))
            .map((e) => e.name);
    } catch (err) {
        log.debug({ err, dir }, "gitChildren read failed");
        return [];
    }
}

/** Resolve `--worktrees-of <name>` to one git root: an absolute path, a direct
 *  child of a search dir, or the single git child whose name starts with
 *  `name`. Zero or several matches is an error naming the candidates. */
export function resolveRepoRoot(dirs: string[], name: string): string {
    if (isAbsolute(name) && isGitRoot(name)) {
        return resolve(name);
    }

    const candidates: string[] = [];
    for (const dir of dirs) {
        const direct = join(dir, name);
        if (isGitRoot(direct)) {
            return direct;
        }

        candidates.push(...gitChildren(dir));
    }

    const prefixed = [...new Set(candidates)].filter((c) => c.startsWith(name));
    if (prefixed.length === 1) {
        for (const dir of dirs) {
            const hit = join(dir, prefixed[0]);
            if (isGitRoot(hit)) {
                return hit;
            }
        }
    }

    const unique = [...new Set(candidates)].sort();
    throw new RepoNotFoundError(
        prefixed.length > 1
            ? `"${name}" matches ${prefixed.length} repositories: ${prefixed.sort().join(", ")}`
            : `no git repository named "${name}" under ${dirs.join(", ")}`,
        unique
    );
}

/** Every live checkout of `repoRoot`: the main one plus its worktrees. Paths
 *  git still lists but that no longer exist (prunable) are dropped, and
 *  symlinks resolve to their target so one tree is never scanned twice. */
export async function worktreeDirs(repoRoot: string): Promise<string[]> {
    const infos = await clonesProfile.measureAsync("discover.worktrees", () => listWorktrees(repoRoot));
    const out: string[] = [];
    const seen = new Set<string>();
    for (const info of infos) {
        if (info.isBare || !existsSync(info.path)) {
            log.debug({ path: info.path, bare: info.isBare }, "worktree skipped");
            continue;
        }

        let real: string;
        try {
            real = realpathSync(info.path);
        } catch (err) {
            log.debug({ err, path: info.path }, "worktree realpath failed");
            continue;
        }

        if (seen.has(real)) {
            continue;
        }

        seen.add(real);
        out.push(real);
    }

    log.info({ repoRoot, listed: infos.length, live: out.length }, "worktrees discovered");
    return out;
}

/** clonefile(2) needs both sides on the same APFS volume. An unknown fs type
 *  (non-darwin, or getattrlist refused) is NOT a reason to drop a root —
 *  `dedupeFile` still refuses at apply time. */
export function partitionApfs(
    roots: string[],
    fsTypeOf: (path: string) => string | null
): { apfs: string[]; skipped: SkippedRoot[] } {
    const apfs: string[] = [];
    const skipped: SkippedRoot[] = [];
    for (const root of roots) {
        const type = fsTypeOf(root);
        if (type !== null && type !== "apfs") {
            skipped.push({ path: root, reason: "not-apfs" });
            continue;
        }

        apfs.push(root);
    }

    return { apfs, skipped };
}

export async function discoverRoots(args: DiscoverArgs): Promise<DiscoverResult> {
    const end = clonesProfile.start("discover");
    const skipped: SkippedRoot[] = [];
    const searchDirs: string[] = [];
    for (const dir of args.dirs) {
        const abs = resolve(dir);
        if (!existsSync(abs)) {
            skipped.push({ path: dir, reason: "missing" });
            continue;
        }

        searchDirs.push(realpathSync(abs));
    }

    let scanDirs = searchDirs;
    if (args.worktreesOf !== undefined && searchDirs.length > 0) {
        const repoRoot = resolveRepoRoot(searchDirs, args.worktreesOf);
        scanDirs = await worktreeDirs(repoRoot);
    }

    const expanded = expandTargets({ dirs: scanDirs, targets: args.targets });
    const apfs = clonesProfile.measure("discover.fs-type", () => partitionApfs(expanded.roots, getFsType));
    const elapsedMs = Math.round(end());
    log.info(
        {
            dirs: args.dirs,
            worktreesOf: args.worktreesOf ?? null,
            searchDirs: searchDirs.length,
            scanDirs: scanDirs.length,
            roots: apfs.apfs.length,
            skipped: skipped.length + expanded.skipped.length + apfs.skipped.length,
            elapsedMs,
        },
        "discoverRoots complete"
    );
    return {
        searchDirs,
        roots: apfs.apfs,
        skipped: [...skipped, ...expanded.skipped, ...apfs.skipped],
    };
}
