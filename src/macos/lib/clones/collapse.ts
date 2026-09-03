import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { emptyFindDuplicatesStats, type FileMetaCacheLike, findDuplicateFiles } from "@genesiscz/utils/fs/disk-usage";
import { logger } from "@genesiscz/utils/logger";
import { getCloneId, getPrivateSize } from "@genesiscz/utils/macos/apfs";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { passesGlobs } from "./filters";
import type { DuplicateSet, DuplicatesReport } from "./render/types";

const log = logger.child({ component: "clones:collapse" });

export interface CollapseArgs {
    roots: string[];
    /** Drop file-groups whose per-file size is below this (bytes). */
    minSize?: number;
    /** Glob patterns: keep only files whose RELPATH or any path-segment matches. */
    include?: string[];
    /** Glob patterns: exclude files whose RELPATH or any path-segment matches (wins). */
    exclude?: string[];
    /** Aborts the underlying walk + hash. Hooked to SIGINT by the CLI. */
    signal?: AbortSignal;
    /** Directory pruning predicate forwarded to the walk. Lets the CLI skip
     *  entire `node_modules` / `.git` subtrees before any syscall is spent
     *  on them — far cheaper than post-filtering globs. */
    shouldEnter?: (dir: string) => boolean;
    /** Forwarded to `walkFiles` — called per directory entered (high rate;
     *  cheap callback only). CLI uses this to drive a live spinner. */
    onDirEntered?: (dir: string) => void;
    /** Forwarded to `findDuplicateFiles`. When provided, the hash phase
     *  reuses cached sha for unchanged files. */
    cache?: FileMetaCacheLike;
    /** P3 — opt-in prefix-hash pre-filter. Forwarded to `findDuplicateFiles`. */
    prefixHash?: boolean;
    /** Package-manager stores. A member under one of these always wins `keep`,
     *  is never a replace target, and stops the directory rollup. */
    keepOnlyRoots?: string[];
    /** Forwarded to `findDuplicateFiles` — injects keep-partner candidates. */
    partnerFor?: (path: string, size: number) => string[];
}

/** True when `path` equals one of `roots` or sits below it. */
export function isUnderAny(path: string, roots: readonly string[]): boolean {
    return roots.some((r) => path === r || path.startsWith(`${r}${sep}`));
}

/** Which root contains `absPath`? Used to relativize for glob matching across
 *  multi-root scans. Returns the first root that's an ancestor. */
function rootOf(absPath: string, roots: string[]): string | null {
    for (const r of roots) {
        if (absPath === r || absPath.startsWith(`${r}${sep}`)) {
            return r;
        }
    }

    return null;
}

interface DirInfo {
    fileCount: number;
    hash: string | null;
    bytes: number;
}

function commonAncestor(paths: string[]): string {
    if (paths.length === 0) {
        return "/";
    }

    const split = paths.map((p) => p.split(sep));
    const first = split[0];
    let i = 0;
    for (; i < first.length; i++) {
        if (!split.every((s) => s[i] === first[i])) {
            break;
        }
    }

    return first.slice(0, i).join(sep) || "/";
}

/** Recursively gather every regular file under `dir` (no symlinks). */
function listFiles(dir: string): string[] {
    const out: string[] = [];
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        log.debug({ err, dir }, "listFiles read failed");
        return out;
    }

    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) {
            continue;
        }

        if (e.isDirectory()) {
            out.push(...listFiles(p));
        } else if (e.isFile()) {
            out.push(p);
        }
    }

    return out;
}

function dirInfo(dir: string, files: string[], shaOf: Map<string, string>, sizeOf: Map<string, number>): DirInfo {
    let bytes = 0;
    const h = createHash("sha256");
    for (const f of files) {
        const sha = shaOf.get(f);
        const size = sizeOf.get(f);
        if (sha === undefined || size === undefined) {
            return { fileCount: files.length, hash: null, bytes };
        }

        bytes += size;
        // dir identity = (relpath, sha) per file. Mode is intentionally NOT
        // hashed: cloning preserves each replace's original mode via dedupeFile's
        // chmodSync restore, so two dirs that differ only in file perms still
        // collapse cleanly into one DuplicateSet — fewer rows, same reclaim.
        h.update(relative(dir, f));
        h.update("\0");
        h.update(sha);
        h.update("\0");
    }

    return { fileCount: files.length, hash: h.digest("hex"), bytes };
}

function isAtOrAboveRoot(dir: string, roots: string[]): boolean {
    return roots.some((root) => dir === root || !relative(dir, root).startsWith(".."));
}

/** Rank a keep candidate. Directories use their files: a cloned tree has
 *  nonzero clone ids and near-zero private bytes; a full copy does not. */
function keepRank(path: string): { shared: boolean; priv: number } {
    const children = listFiles(path);
    if (children.length > 0) {
        let priv = 0;
        let shared = false;
        for (const f of children) {
            const id = getCloneId(f);
            if (id !== null && id !== 0n) {
                shared = true;
            }

            const n = getPrivateSize(f);
            if (n !== null) {
                priv += n;
            }
        }

        return { shared, priv };
    }

    const id = getCloneId(path);
    const n = getPrivateSize(path);
    return {
        shared: id !== null && id !== 0n,
        priv: n === null ? Number.POSITIVE_INFINITY : n,
    };
}

/** Prefer a member that already shares extents so --apply clonefile's onto it
 *  (and frees the private copy) instead of the other way around. Lex path is
 *  the stable tie-break when clone-id and private size match. */
function pickKeep(members: string[], keepOnlyRoots: readonly string[]): string {
    const keepOnly = members.filter((m) => isUnderAny(m, keepOnlyRoots)).sort();
    if (keepOnly.length > 0) {
        return keepOnly[0];
    }

    let best = members[0];
    let bestRank = keepRank(best);
    for (let i = 1; i < members.length; i++) {
        const candidate = members[i];
        const rank = keepRank(candidate);
        if (rank.shared !== bestRank.shared) {
            if (rank.shared) {
                best = candidate;
                bestRank = rank;
            }

            continue;
        }

        if (rank.priv !== bestRank.priv) {
            if (rank.priv < bestRank.priv) {
                best = candidate;
                bestRank = rank;
            }

            continue;
        }

        if (candidate < best) {
            best = candidate;
        }
    }

    return best;
}

export async function collapseDuplicates({
    roots,
    minSize,
    include,
    exclude,
    signal,
    shouldEnter,
    onDirEntered,
    cache,
    prefixHash,
    keepOnlyRoots = [],
    partnerFor,
}: CollapseArgs): Promise<DuplicatesReport> {
    const sw = new Stopwatch();
    const shaOf = new Map<string, string>();
    const sizeOf = new Map<string, number>();
    const fileGroups: { sha256: string; size: number; paths: string[] }[] = [];
    // One stats accumulator across all roots — findDuplicateFiles ADDS to its
    // counters, so we get sum-of-roots in `stats` at the end.
    const stats = emptyFindDuplicatesStats();

    // ONE walk over every root, bucketed together: a file that is alone in its
    // own root still meets its twin in another root (the worktree case).
    const findOpts: Parameters<typeof findDuplicateFiles>[1] = { stats };
    if (minSize !== undefined) {
        findOpts.minSize = minSize;
    }
    if (signal !== undefined) {
        findOpts.signal = signal;
    }
    if (shouldEnter !== undefined) {
        findOpts.shouldEnter = shouldEnter;
    }
    if (onDirEntered !== undefined) {
        findOpts.onDirEntered = onDirEntered;
    }
    if (cache !== undefined) {
        findOpts.cache = cache;
    }
    if (prefixHash === true) {
        findOpts.prefixHash = true;
    }
    if (partnerFor !== undefined) {
        findOpts.partnerFor = partnerFor;
    }
    for (const g of await findDuplicateFiles(roots, findOpts)) {
        // If include/exclude prunes the group below 2 paths it is no longer a
        // duplicate — drop it. Keep-partner paths live outside every root and
        // are never glob-filtered.
        const filtered =
            (include && include.length > 0) || (exclude && exclude.length > 0)
                ? g.paths.filter((p) => {
                      const containingRoot = rootOf(p, roots);
                      if (containingRoot === null) {
                          return true;
                      }

                      return passesGlobs(relative(containingRoot, p), include, exclude);
                  })
                : g.paths;
        if (filtered.length < 2) {
            continue;
        }

        for (const p of filtered) {
            shaOf.set(p, g.sha256);
            sizeOf.set(p, g.size);
        }

        fileGroups.push({ sha256: g.sha256, size: g.size, paths: filtered });
    }

    // The ancestor walk re-enumerates the same dirs many times — once per
    // file group, once per cursor level. Memoise both the sorted file list
    // and the derived DirInfo so each dir is walked exactly once.
    const filesCache = new Map<string, string[]>();
    const listFilesCached = (dir: string): string[] => {
        const hit = filesCache.get(dir);
        if (hit) {
            return hit;
        }

        const out = listFiles(dir).sort();
        filesCache.set(dir, out);
        return out;
    };

    const dirCache = new Map<string, DirInfo>();
    const infoFor = (dir: string): DirInfo => {
        const cached = dirCache.get(dir);
        if (cached) {
            return cached;
        }

        const info = dirInfo(dir, listFilesCached(dir), shaOf, sizeOf);
        dirCache.set(dir, info);
        return info;
    };

    // Keep-only roots join the hard stop so a cache-side rollup can never
    // ascend into (or above) the package-manager store.
    const hardStopRoots = [...roots, ...keepOnlyRoots];
    const consumed = new Set<string>();
    const sets: DuplicateSet[] = [];
    const ancestor = commonAncestor(roots);
    // Name a set after the member that lives inside a scan root, so a set whose
    // keep is a store file does not read as "../../.bun/…".
    const displayName = (members: string[]): string => {
        const inRoot = members.find((m) => rootOf(m, roots) !== null) ?? members[0];
        return relative(ancestor, inRoot) || inRoot;
    };

    for (const g of fileGroups) {
        if (g.paths.some((p) => consumed.has(p))) {
            continue;
        }

        let bestDirs: string[] | null = null;
        let bestInfo: DirInfo | null = null;
        let cursor = g.paths.map((p) => dirname(p));

        while (cursor.every((d) => !isAtOrAboveRoot(d, hardStopRoots))) {
            const infos = cursor.map(infoFor);
            const counts = new Set(infos.map((i) => i.fileCount));
            // Null-hashed dirs must compare distinct from every other dir; key
            // on the dir path so the sentinel stays deterministic across runs.
            const hashes = new Set(infos.map((i, idx) => i.hash ?? `__null:${cursor[idx]}`));
            const basenames = new Set(cursor.map((d) => basename(d)));
            if (counts.size === 1 && hashes.size === 1 && basenames.size === 1 && infos[0].hash !== null) {
                bestDirs = [...cursor];
                bestInfo = infos[0];
                cursor = cursor.map((d) => dirname(d));
                continue;
            }

            break;
        }

        if (bestDirs && bestInfo) {
            const members = [...new Set(bestDirs)].sort();
            if (members.length >= 2) {
                for (const m of members) {
                    for (const f of listFilesCached(m)) {
                        consumed.add(f);
                    }
                }

                sets.push({
                    kind: "dir",
                    what: displayName(members),
                    copies: members.length,
                    eachBytes: bestInfo.bytes,
                    reclaimable: (members.length - 1) * bestInfo.bytes,
                    members,
                    keep: pickKeep(members, keepOnlyRoots),
                });
            }
        }
    }

    for (const g of fileGroups) {
        const remaining = g.paths.filter((p) => !consumed.has(p)).sort();
        if (remaining.length < 2) {
            continue;
        }

        for (const p of remaining) {
            consumed.add(p);
        }

        sets.push({
            kind: "file",
            what: displayName(remaining),
            copies: remaining.length,
            eachBytes: g.size,
            reclaimable: (remaining.length - 1) * g.size,
            members: remaining,
            keep: pickKeep(remaining, keepOnlyRoots),
        });
    }

    // A keep-only member that is not the keep can never be replaced, so it must
    // not inflate `copies` or `reclaimable`.
    const normalized = sets.flatMap((set) => {
        const members = set.members.filter((m) => m === set.keep || !isUnderAny(m, keepOnlyRoots));
        if (members.length === set.members.length) {
            return [set];
        }

        if (members.length < 2) {
            return [];
        }

        return [
            {
                ...set,
                members,
                copies: members.length,
                reclaimable: (members.length - 1) * set.eachBytes,
            },
        ];
    });
    sets.length = 0;
    sets.push(...normalized);

    const totalReclaimable = sets.reduce((s, x) => s + x.reclaimable, 0);
    const dirSets = sets.filter((s) => s.kind === "dir").length;
    const fileSets = sets.length - dirSets;
    log.info(
        {
            roots,
            rootCount: roots.length,
            fileGroups: fileGroups.length,
            dirSets,
            fileSets,
            totalReclaimable,
            cacheHits: stats.cacheHits,
            cacheMisses: stats.cacheMisses,
            sha256Calls: stats.sha256Calls,
            elapsedMs: Math.round(sw.elapsedMs),
        },
        "collapseDuplicates complete"
    );
    return { roots, sets, totalReclaimable, grouped: false, hardStop: roots, stats };
}
