import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import logger from "@app/logger";
import { formatBytes } from "@app/utils/format";
import { type DiskUsage, findCloneFamilies, freeDiskSpace, measureTree, walkFiles } from "@app/utils/fs/disk-usage";
import { getCloneId, getPrivateSize } from "@app/utils/macos/apfs";
import { Stopwatch } from "@app/utils/Stopwatch";
import { matchGlob } from "@app/utils/string";
import type { CloneAnalysis, DirNode, MeasureReport } from "./render/types";

const log = logger.child({ component: "clones:orchestrator" });

export interface BuildMeasureArgs {
    roots: string[];
    minReal: number;
    breakdown: boolean;
    include?: string[];
    exclude?: string[];
    sort?: "overcount" | "real" | "du";
    maxDepth?: number;
    /** When true, walk known external clone-aware locations (bun cache) to
     *  resolve `cloneAnalysis.crossTreePartners` and the partner note. Off by
     *  default — the probe can take seconds on large caches and is purely
     *  informational (doesn't change reclaim totals). Wire from `--show-partners`. */
    probePartners?: boolean;
}

/** Resolve scan roots: explicit → configured watchedDirs → cwd (spec §1). */
export function resolveRoots(explicit: string[], watchedDirs: string[]): string[] {
    if (explicit.length > 0) {
        return explicit.map((p) => resolve(p));
    }

    if (watchedDirs.length > 0) {
        return watchedDirs.map((p) => resolve(p));
    }

    return [process.cwd()];
}

/** Expand each root to its node_modules dirs via `find -prune` (NOT fd —
 *  node_modules is gitignored; fd skips it). Spec §1. */
export function expandNodeModules(roots: string[]): string[] {
    const out: string[] = [];
    for (const root of roots) {
        try {
            const stdout = execFileSync("find", [root, "-type", "d", "-name", "node_modules", "-prune"], {
                encoding: "utf8",
                maxBuffer: 64 * 1024 * 1024,
            });
            for (const line of stdout.split("\n")) {
                const p = line.trim();
                if (p.length > 0) {
                    out.push(p);
                }
            }
        } catch (err) {
            log.warn({ err, root }, "node_modules expansion failed");
        }
    }

    return out;
}

interface MutNode {
    path: string;
    depth: number;
    logical: number;
    allocated: number;
    real: number | null;
    realSeen: boolean;
    /** Sum of (allocated - private) for files in this subtree whose clone-id
     *  has only ONE in-tree member (i.e. the sharing partner lives outside the
     *  measured roots — typically the bun install cache). */
    crossTreeShared: number;
    children: Map<string, MutNode>;
}

function emptyNode(path: string, depth: number): MutNode {
    return {
        path,
        depth,
        logical: 0,
        allocated: 0,
        real: 0,
        realSeen: false,
        crossTreeShared: 0,
        children: new Map(),
    };
}

interface CrossTreeData {
    /** path → bytes its lone family contributes to cross-tree shared total. */
    sharedByPath: Map<string, number>;
    /** Hex clone-ids whose only in-tree member is in `sharedByPath` — these
     *  are the families whose sharing partners live outside the scan roots. */
    loneCloneIds: Set<string>;
}

/** First pass: build path → cross-tree-shared bytes + the lone clone-id set.
 *  Cross-tree = the clone-id appears EXACTLY once in the measured roots, so
 *  the family's other members are external. shared = allocated - private for
 *  those lone in-tree files. */
function detectCrossTreeShared(roots: string[]): CrossTreeData {
    const byCloneId = new Map<string, { path: string; allocated: number; priv: number }[]>();
    for (const root of roots) {
        for (const e of walkFiles(root, { onError: (err) => log.debug({ err }, "cross-tree walk") })) {
            const id = getCloneId(e.path);
            if (id === null || id === 0n) {
                continue;
            }

            const key = id.toString(16);
            const priv = getPrivateSize(e.path) ?? e.allocated;
            const list = byCloneId.get(key) ?? [];
            list.push({ path: e.path, allocated: e.allocated, priv });
            byCloneId.set(key, list);
        }
    }

    const sharedByPath = new Map<string, number>();
    const loneCloneIds = new Set<string>();
    for (const [key, files] of byCloneId) {
        if (files.length !== 1) {
            continue;
        }

        const f = files[0];
        const shared = Math.max(0, f.allocated - f.priv);
        if (shared > 0) {
            sharedByPath.set(f.path, shared);
            loneCloneIds.add(key);
        }
    }

    return { sharedByPath, loneCloneIds };
}

/** Known external locations that DO use APFS clonefile — the only places
 *  worth probing to discover the WHERE of cross-tree partners. Bun is the
 *  primary suspect (`bun install` clones from cache to node_modules). */
function partnerProbePaths(): string[] {
    const home = homedir();
    return [`${home}/.bun/install/cache`, `${home}/.bun/install/global`].filter((p) => existsSync(p));
}

/** Wall-clock budget for the partner probe. The probe is best-effort; if we
 *  blow the budget we report whatever partners we found so far + log it.
 *  10s lets us walk a typical bun cache (~50k files × ~100µs getattrlist). */
const PARTNER_PROBE_BUDGET_MS = 10_000;

/** Walk known cache locations to find files with a clone-id matching any of
 *  `loneIds`. Returns the deduplicated DIRS where matches were found (more
 *  useful than per-file paths for the user-facing "cross-tree partners" list).
 *  Each probe path uses a wall-clock budget; partial results are returned on
 *  timeout. Empty when `loneIds` is empty or no probe location exists. */
function findCrossTreePartners(loneIds: Set<string>): string[] {
    if (loneIds.size === 0) {
        return [];
    }

    const probes = partnerProbePaths();
    if (probes.length === 0) {
        log.info({ loneIds: loneIds.size }, "partner probe skipped — no known cache locations exist");
        return [];
    }

    const sw = new Stopwatch();
    const start = Date.now();
    const partnerDirs = new Set<string>();
    const remaining = new Set(loneIds);
    let filesScanned = 0;

    for (const probe of probes) {
        if (remaining.size === 0) {
            break;
        }

        let timedOut = false;
        for (const e of walkFiles(probe, { onError: (err) => log.debug({ err }, "partner probe walk") })) {
            if (remaining.size === 0) {
                break;
            }

            if (Date.now() - start > PARTNER_PROBE_BUDGET_MS) {
                timedOut = true;
                break;
            }

            filesScanned += 1;
            const id = getCloneId(e.path);
            if (id === null || id === 0n) {
                continue;
            }

            const key = id.toString(16);
            if (!remaining.has(key)) {
                continue;
            }

            remaining.delete(key);
            partnerDirs.add(dirname(e.path));
        }

        if (timedOut) {
            log.warn(
                {
                    probe,
                    foundCount: partnerDirs.size,
                    remainingIds: remaining.size,
                    filesScanned,
                    elapsedMs: Math.round(sw.elapsedMs),
                },
                "partner probe budget exhausted — partial results"
            );
            break;
        }
    }

    log.info(
        {
            probes,
            wanted: loneIds.size,
            found: partnerDirs.size,
            unresolved: remaining.size,
            filesScanned,
            elapsedMs: Math.round(sw.elapsedMs),
        },
        "partner probe complete"
    );
    return [...partnerDirs].sort();
}

function anySegmentMatches(rel: string, glob: string): boolean {
    if (matchGlob(rel, glob)) {
        return true;
    }

    for (const seg of rel.split("/")) {
        if (matchGlob(seg, glob)) {
            return true;
        }
    }

    return false;
}

function passesGlobs(rel: string, base: string, include?: string[], exclude?: string[]): boolean {
    if (exclude?.some((g) => anySegmentMatches(rel, g) || matchGlob(base, g))) {
        return false;
    }

    if (include && include.length > 0) {
        return include.some((g) => anySegmentMatches(rel, g) || matchGlob(base, g));
    }

    return true;
}

function buildRootTree(root: string, args: BuildMeasureArgs, crossTreeShared: Map<string, number>): MutNode {
    const rootNode = emptyNode(root, 0);
    for (const e of walkFiles(root, { onError: (err) => log.debug({ err }, "walk error") })) {
        const rel = relative(root, e.path);
        if (!passesGlobs(rel, e.path.split("/").pop() ?? "", args.include, args.exclude)) {
            continue;
        }

        const parts = dirname(rel) === "." ? [] : dirname(rel).split("/");

        const priv = getPrivateSize(e.path);
        const fileShared = crossTreeShared.get(e.path) ?? 0;
        let node = rootNode;
        node.logical += e.logical;
        node.allocated += e.allocated;
        node.crossTreeShared += fileShared;
        if (priv !== null) {
            node.real = (node.real ?? 0) + priv;
            node.realSeen = true;
        }

        // Stop CREATING child nodes past maxDepth, but the totals above were
        // already accumulated into the root + every ancestor that still exists.
        // Effect: `du --depth N` tree rows show their full subtree totals
        // (matching the TOTAL line), while only the rendered tree is depth-capped.
        const partsToWalk = args.maxDepth !== undefined ? parts.slice(0, args.maxDepth) : parts;

        let acc = root;
        let depth = 0;
        for (const part of partsToWalk) {
            acc = `${acc}/${part}`;
            depth += 1;
            let child = node.children.get(part);
            if (!child) {
                child = emptyNode(acc, depth);
                node.children.set(part, child);
            }

            child.logical += e.logical;
            child.allocated += e.allocated;
            child.crossTreeShared += fileShared;
            if (priv !== null) {
                child.real = (child.real ?? 0) + priv;
                child.realSeen = true;
            }

            node = child;
        }
    }

    return rootNode;
}

/** Deepest-significant keep rule (spec §5): keep D iff real(D) > minReal;
 *  if a single kept child C has real(C) >= 0.9*real(D), D is pass-through
 *  (its child replaces it). A dir is kept when its OWN real > minReal even
 *  if no single child is. */
function pruneTree(node: MutNode, minReal: number): DirNode[] {
    const keptChildren: DirNode[] = [];
    for (const child of node.children.values()) {
        keptChildren.push(...pruneTree(child, minReal));
    }

    const real = node.realSeen ? (node.real ?? 0) : null;
    const childRealSum = keptChildren.reduce((s, c) => s + (c.real ?? 0), 0);
    const ownReal = real === null ? null : real - childRealSum;
    const significant = real !== null && real > minReal;
    const ownSignificant = ownReal !== null && ownReal > minReal;

    if (!significant && keptChildren.length === 0) {
        return [];
    }

    const dominant =
        real !== null && real > 0 && keptChildren.length === 1 && (keptChildren[0].real ?? 0) >= 0.9 * real;
    if (dominant && !ownSignificant) {
        return keptChildren;
    }

    if (!significant && !ownSignificant) {
        return keptChildren;
    }

    const overcount = real !== null && real > 0 ? node.allocated / real : real === 0 ? 1 : null;
    return [
        {
            path: node.path,
            depth: node.depth,
            logical: node.logical,
            allocated: node.allocated,
            real,
            overcount,
            children: keptChildren.map((c) => ({ ...c, depth: c.depth })),
            ...(node.crossTreeShared > 0
                ? {
                      sharedNote: `${formatBytes(node.crossTreeShared)} shared with cross-tree partner (stays on disk if deleted)`,
                  }
                : {}),
        },
    ];
}

function buildCloneAnalysis(
    roots: string[],
    crossTree: CrossTreeData,
    opts: { probePartners: boolean }
): CloneAnalysis {
    let families = 0;
    let clonedFiles = 0;
    for (const root of roots) {
        const fams = findCloneFamilies(root);
        families += fams.size;
        for (const members of fams.values()) {
            clonedFiles += members.length;
        }
    }

    let sharedBytes = 0;
    for (const v of crossTree.sharedByPath.values()) {
        sharedBytes += v;
    }

    // Probe is OFF by default — bun cache can be GB and the walk would add
    // seconds to every measure on a real `node_modules` tree. Opt-in via
    // `--show-partners` when the user actually wants the WHERE info.
    const crossTreePartners = opts.probePartners ? findCrossTreePartners(crossTree.loneCloneIds) : [];

    const notes: string[] = [];
    if (sharedBytes > 0) {
        notes.push(
            `${formatBytes(sharedBytes)} of measured bytes are shared with files OUTSIDE the scan roots ` +
                "and won't be freed by deleting these dirs."
        );
        if (crossTreePartners.length > 0) {
            notes.push(
                `partner(s) located in: ${crossTreePartners.slice(0, 3).join(", ")}` +
                    (crossTreePartners.length > 3 ? ` (+${crossTreePartners.length - 3} more)` : "")
            );
        } else if (!opts.probePartners && crossTree.loneCloneIds.size > 0) {
            notes.push(
                `${crossTree.loneCloneIds.size} clone family(ies) have partners outside the scan — rerun with --show-partners to locate them.`
            );
        }
    }

    return { families, clonedFiles, sharedBytes, crossTreePartners, notes };
}

function sortTree(nodes: DirNode[], by: "overcount" | "real" | "du"): DirNode[] {
    const key = (n: DirNode): number =>
        by === "real" ? (n.real ?? -1) : by === "du" ? n.allocated : (n.overcount ?? -1);
    return [...nodes].sort((a, b) => key(b) - key(a)).map((n) => ({ ...n, children: sortTree(n.children, by) }));
}

export function buildMeasureReport(args: BuildMeasureArgs): MeasureReport {
    const sw = new Stopwatch();
    const totalsAgg: DiskUsage = {
        logical: 0,
        allocated: 0,
        private: null,
        exactReclaimable: null,
        fileCount: 0,
        dirCount: 0,
        errors: [],
    };
    let realSeen = false;
    const tree: DirNode[] = [];

    const swCross = new Stopwatch();
    const crossTree = detectCrossTreeShared(args.roots);
    const crossTreeMs = Math.round(swCross.elapsedMs);

    for (const root of args.roots) {
        const u = measureTree(root);
        totalsAgg.logical += u.logical;
        totalsAgg.allocated += u.allocated;
        totalsAgg.fileCount += u.fileCount;
        totalsAgg.dirCount += u.dirCount;
        if (u.private !== null) {
            realSeen = true;
            totalsAgg.private = (totalsAgg.private ?? 0) + u.private;
        }

        totalsAgg.errors.push(...u.errors);

        if (args.breakdown) {
            const rootMut = buildRootTree(root, args, crossTree.sharedByPath);
            tree.push(...pruneTree(rootMut, args.minReal));
        }
    }

    const totalReal = realSeen ? totalsAgg.private : null;
    const totalOvercount = totalReal !== null && totalReal > 0 ? totalsAgg.allocated / totalReal : null;
    const fs = freeDiskSpace(args.roots[0]);
    const sorted = args.breakdown ? sortTree(tree, args.sort ?? "overcount") : [];
    const swPartners = new Stopwatch();
    const cloneAnalysis = buildCloneAnalysis(args.roots, crossTree, { probePartners: Boolean(args.probePartners) });
    const partnerProbeMs = args.probePartners ? Math.round(swPartners.elapsedMs) : 0;

    log.info(
        {
            roots: args.roots,
            rootCount: args.roots.length,
            breakdown: args.breakdown,
            probePartners: Boolean(args.probePartners),
            totalMs: Math.round(sw.elapsedMs),
            crossTreeDetectMs: crossTreeMs,
            partnerProbeMs,
            loneCloneIds: crossTree.loneCloneIds.size,
            sharedBytes: cloneAnalysis.sharedBytes,
            partners: cloneAnalysis.crossTreePartners.length,
            files: totalsAgg.fileCount,
            logical: totalsAgg.logical,
            allocated: totalsAgg.allocated,
            real: totalReal,
            errors: totalsAgg.errors.length,
        },
        "buildMeasureReport complete"
    );

    return {
        roots: args.roots,
        nodeModulesMode: false,
        minReal: args.minReal,
        tree: sorted,
        totals: {
            logical: totalsAgg.logical,
            allocated: totalsAgg.allocated,
            real: totalReal,
            overcount: totalOvercount,
        },
        cloneAnalysis,
        freeSpace: { total: fs.total, free: fs.free, available: fs.available },
        errors: totalsAgg.errors.map((e) => ({ path: e.path, errno: e.errno })),
    };
}
