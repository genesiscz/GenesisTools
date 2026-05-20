import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { logger } from "@app/logger";
import { findDuplicateFiles } from "@app/utils/fs/disk-usage";
import { Stopwatch } from "@app/utils/Stopwatch";
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

export function collapseDuplicates({ roots, minSize, include, exclude }: CollapseArgs): DuplicatesReport {
    const sw = new Stopwatch();
    const shaOf = new Map<string, string>();
    const sizeOf = new Map<string, number>();
    const fileGroups: { sha256: string; size: number; paths: string[] }[] = [];

    for (const root of roots) {
        for (const g of findDuplicateFiles(root, minSize !== undefined ? { minSize } : {})) {
            // If include/exclude prunes the group below 2 paths it is no
            // longer a duplicate — drop it.
            const filtered =
                (include && include.length > 0) || (exclude && exclude.length > 0)
                    ? g.paths.filter((p) => {
                          const containingRoot = rootOf(p, roots) ?? root;
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

    const consumed = new Set<string>();
    const sets: DuplicateSet[] = [];
    const ancestor = commonAncestor(roots);

    for (const g of fileGroups) {
        if (g.paths.some((p) => consumed.has(p))) {
            continue;
        }

        let bestDirs: string[] | null = null;
        let bestInfo: DirInfo | null = null;
        let cursor = g.paths.map((p) => dirname(p));

        while (cursor.every((d) => !isAtOrAboveRoot(d, roots))) {
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
                    what: relative(ancestor, members[0]) || members[0],
                    copies: members.length,
                    eachBytes: bestInfo.bytes,
                    reclaimable: (members.length - 1) * bestInfo.bytes,
                    members,
                    keep: members[0],
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
            what: relative(ancestor, remaining[0]) || remaining[0],
            copies: remaining.length,
            eachBytes: g.size,
            reclaimable: (remaining.length - 1) * g.size,
            members: remaining,
            keep: remaining[0],
        });
    }

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
            elapsedMs: Math.round(sw.elapsedMs),
        },
        "collapseDuplicates complete"
    );
    return { roots, sets, totalReclaimable, grouped: false, hardStop: roots };
}
