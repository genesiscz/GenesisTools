import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import logger from "@app/logger";
import { formatBytes } from "@app/utils/format";
import { type DiskUsage, freeDiskSpace, type WalkError, walkFiles } from "@app/utils/fs/disk-usage";
import { getCloneId, getPrivateSize } from "@app/utils/macos/apfs";
import { Stopwatch } from "@app/utils/Stopwatch";
import { passesGlobs } from "./filters";
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
    /** null = no per-file `private` value was ever contributed; once any file
     *  contributes, this becomes a (non-null) running sum. Distinguishes
     *  "unsupported" from "supported but zero". */
    real: number | null;
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
        real: null,
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

/** Per-file record materialised by the single walk. Carries the two
 *  getattrlist attrs alongside the regular logical/allocated sizes so the
 *  downstream reductions (cross-tree, tree-build, clone-analysis) don't have
 *  to re-walk or re-syscall. `cloneId`/`priv` are null when getattrlist
 *  returned an error (off-darwin or syscall failure for that path). */
interface EnrichedEntry {
    path: string;
    logical: number;
    allocated: number;
    cloneId: bigint | null;
    priv: number | null;
}

interface RootRecords {
    entries: EnrichedEntry[];
    errors: WalkError[];
}

/** Single walk per root. Captures (logical, allocated, cloneId, priv) per
 *  file in one pass — no filters applied here so the cross-tree pass that
 *  follows can see the full picture. Includes are honoured later when each
 *  per-root record set is folded into the per-dir tree + totals. */
function gatherEnrichedRecords(roots: string[]): Map<string, RootRecords> {
    const out = new Map<string, RootRecords>();
    let totalEntries = 0;
    for (const root of roots) {
        const errors: WalkError[] = [];
        const entries: EnrichedEntry[] = [];
        for (const e of walkFiles(root, { onError: (err) => errors.push(err) })) {
            entries.push({
                path: e.path,
                logical: e.logical,
                allocated: e.allocated,
                cloneId: getCloneId(e.path),
                priv: getPrivateSize(e.path),
            });
        }

        out.set(root, { entries, errors });
        totalEntries += entries.length;
    }

    log.debug({ rootCount: roots.length, totalEntries }, "enriched records gathered");
    return out;
}

/** Build path → cross-tree-shared bytes + the lone clone-id set, from already
 *  materialised records. Cross-tree = the clone-id appears EXACTLY once in
 *  the measured roots, so the family's other members are external.
 *  shared = allocated - private for those lone in-tree files. */
function detectCrossTreeShared(records: Map<string, RootRecords>): CrossTreeData {
    const byCloneId = new Map<string, { path: string; allocated: number; priv: number }[]>();
    for (const { entries } of records.values()) {
        for (const e of entries) {
            if (e.cloneId === null || e.cloneId === 0n) {
                continue;
            }

            const key = e.cloneId.toString(16);
            const priv = e.priv ?? e.allocated;
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

interface WalkRootResult {
    /** Per-dir aggregation tree. Only meaningful when args.breakdown is true. */
    tree: MutNode;
    /** Whole-root DiskUsage aggregate. Populated in the same pass as `tree`. */
    aggregate: DiskUsage;
    /** True iff at least one INCLUDED file in this root had `priv === null`.
     *  Distinct from `aggregate.private === null`, which is set only when
     *  EVERY included file had null priv; this catches the mixed-null case
     *  where 999/1000 files have priv and 1 doesn't (the running sum is then
     *  a misleading partial). */
    privateUnknown: boolean;
}

/** Fold an already-materialised RootRecords into the per-dir tree AND the
 *  whole-root DiskUsage aggregate. Honors include/exclude so the TOTAL line
 *  matches the displayed tree exactly (a filtered-out file contributes to
 *  neither). */
function walkRoot(
    root: string,
    records: RootRecords,
    args: BuildMeasureArgs,
    crossTreeShared: Map<string, number>
): WalkRootResult {
    const rootNode = emptyNode(root, 0);
    const aggregate: DiskUsage = {
        logical: 0,
        allocated: 0,
        private: null,
        exactReclaimable: null,
        fileCount: 0,
        dirCount: 0,
        errors: records.errors,
    };
    let privateSum: number | null = null;
    let privateUnknown = false;
    const dirs = new Set<string>();
    const rootKey = root.endsWith("/") ? root.slice(0, -1) : root;

    for (const e of records.entries) {
        const rel = relative(root, e.path);
        if (!passesGlobs(rel, args.include, args.exclude, basename(e.path))) {
            continue;
        }

        const parts = dirname(rel) === "." ? [] : dirname(rel).split("/");

        const priv = e.priv;
        const fileShared = crossTreeShared.get(e.path) ?? 0;

        // Whole-root aggregate (always populated, even when !args.breakdown).
        aggregate.fileCount += 1;
        aggregate.logical += e.logical;
        aggregate.allocated += e.allocated;
        const parent = e.path.slice(0, e.path.lastIndexOf("/"));
        if (parent !== rootKey) {
            dirs.add(parent);
        }

        if (priv === null) {
            privateUnknown = true;
        } else {
            privateSum = (privateSum ?? 0) + priv;
        }

        // Per-dir tree (populated regardless of breakdown — the root node
        // itself is the always-true totals row; child population is the only
        // thing depth-gated below).
        let node = rootNode;
        node.logical += e.logical;
        node.allocated += e.allocated;
        node.crossTreeShared += fileShared;
        if (priv !== null) {
            node.real = (node.real ?? 0) + priv;
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
            }

            node = child;
        }
    }

    aggregate.dirCount = dirs.size;
    aggregate.private = privateSum;
    aggregate.exactReclaimable = aggregate.private;
    return { tree: rootNode, aggregate, privateUnknown };
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

    const real = node.real;
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

    let overcount: number | null;
    if (real === null) {
        overcount = null;
    } else if (real === 0) {
        overcount = 1;
    } else {
        overcount = node.allocated / real;
    }

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
    records: Map<string, RootRecords>,
    crossTree: CrossTreeData,
    args: BuildMeasureArgs,
    opts: { probePartners: boolean }
): CloneAnalysis {
    // Single fold: family detection AND sharedBytes summing in one record
    // pass. `passing` tracks whether the file would survive the user's
    // include/exclude filters — the reported counts/bytes must match the
    // filtered tree+totals or the output is self-contradictory.
    //
    // Cross-tree DETECTION upstream stays unfiltered (lone-family detection
    // needs the full picture to distinguish in-tree from cross-tree families).
    // What we filter here is the REPORT.
    const familyMembers = new Map<string, { total: number; passing: number }>();
    // Lone clone-ids whose lone in-tree member passes the user's filters.
    // Partner probing + the "rerun with --show-partners" count must use this
    // subset, not the unfiltered crossTree.loneCloneIds — otherwise probing
    // could surface partners for families the user just filtered out.
    const visibleLoneCloneIds = new Set<string>();
    let sharedBytes = 0;
    for (const [root, { entries }] of records) {
        for (const e of entries) {
            const rel = relative(root, e.path);
            const passing = passesGlobs(rel, args.include, args.exclude, basename(e.path));
            if (e.cloneId !== null && e.cloneId !== 0n) {
                const key = e.cloneId.toString(16);
                const acc = familyMembers.get(key) ?? { total: 0, passing: 0 };
                acc.total += 1;
                if (passing) {
                    acc.passing += 1;
                    if (crossTree.loneCloneIds.has(key)) {
                        visibleLoneCloneIds.add(key);
                    }
                }

                familyMembers.set(key, acc);
            }

            if (passing) {
                sharedBytes += crossTree.sharedByPath.get(e.path) ?? 0;
            }
        }
    }

    let families = 0;
    let clonedFiles = 0;
    for (const acc of familyMembers.values()) {
        // A clone family requires ≥2 members in the full tree (otherwise it's
        // a stale cloneId on a lone file). Then we surface only those families
        // with at least one filter-visible member, and count just the visible
        // members so the report matches what the user actually sees.
        if (acc.total < 2 || acc.passing === 0) {
            continue;
        }

        families += 1;
        clonedFiles += acc.passing;
    }

    // Probe is OFF by default — bun cache can be GB and the walk would add
    // seconds to every measure on a real `node_modules` tree. Opt-in via
    // `--show-partners` when the user actually wants the WHERE info.
    const crossTreePartners = opts.probePartners ? findCrossTreePartners(visibleLoneCloneIds) : [];

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
        } else if (!opts.probePartners && visibleLoneCloneIds.size > 0) {
            notes.push(
                `${visibleLoneCloneIds.size} clone family(ies) have partners outside the scan — rerun with --show-partners to locate them.`
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
    let privateUnknown = false;
    const tree: DirNode[] = [];

    // Materialise once → reduce three times. Each root is walked exactly once;
    // each file pays for exactly one getCloneId + one getPrivateSize. The three
    // downstream passes (cross-tree, tree-build, clone-analysis) consume the
    // resulting records map without touching the filesystem.
    const swWalk = new Stopwatch();
    const records = gatherEnrichedRecords(args.roots);
    const walkMs = Math.round(swWalk.elapsedMs);

    const swCross = new Stopwatch();
    const crossTree = detectCrossTreeShared(records);
    const crossTreeMs = Math.round(swCross.elapsedMs);

    for (const root of args.roots) {
        const rootRecs = records.get(root);
        if (!rootRecs) {
            continue;
        }

        const {
            tree: rootMut,
            aggregate: u,
            privateUnknown: rootPrivateUnknown,
        } = walkRoot(root, rootRecs, args, crossTree.sharedByPath);
        totalsAgg.logical += u.logical;
        totalsAgg.allocated += u.allocated;
        totalsAgg.fileCount += u.fileCount;
        totalsAgg.dirCount += u.dirCount;
        if (rootPrivateUnknown) {
            // Any included file with priv === null taints the total — a
            // partial sum would underreport reclaim while looking definitive.
            // Catches both the all-null case AND the mixed-null case (one
            // file's priv missing among many).
            privateUnknown = true;
        }

        if (u.private !== null) {
            totalsAgg.private = (totalsAgg.private ?? 0) + u.private;
        }

        totalsAgg.errors.push(...u.errors);

        if (args.breakdown) {
            tree.push(...pruneTree(rootMut, args.minReal));
        }
    }

    const totalReal = privateUnknown ? null : totalsAgg.private;
    const totalOvercount = totalReal !== null && totalReal > 0 ? totalsAgg.allocated / totalReal : null;
    const fs = freeDiskSpace(args.roots[0]);
    const sorted = args.breakdown ? sortTree(tree, args.sort ?? "overcount") : [];
    const swPartners = new Stopwatch();
    const cloneAnalysis = buildCloneAnalysis(records, crossTree, args, { probePartners: Boolean(args.probePartners) });
    const partnerProbeMs = args.probePartners ? Math.round(swPartners.elapsedMs) : 0;

    let recordCount = 0;
    for (const { entries } of records.values()) {
        recordCount += entries.length;
    }

    log.info(
        {
            roots: args.roots,
            rootCount: args.roots.length,
            breakdown: args.breakdown,
            probePartners: Boolean(args.probePartners),
            totalMs: Math.round(sw.elapsedMs),
            walkMs,
            crossTreeDetectMs: crossTreeMs,
            partnerProbeMs,
            recordCount,
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
