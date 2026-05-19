import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import logger from "@app/logger";
import { type DiskUsage, findCloneFamilies, freeDiskSpace, measureTree, walkFiles } from "@app/utils/fs/disk-usage";
import { getPrivateSize } from "@app/utils/macos/apfs";
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
    children: Map<string, MutNode>;
}

function emptyNode(path: string, depth: number): MutNode {
    return { path, depth, logical: 0, allocated: 0, real: 0, realSeen: false, children: new Map() };
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

function buildRootTree(root: string, args: BuildMeasureArgs): MutNode {
    const rootNode = emptyNode(root, 0);
    for (const e of walkFiles(root, { onError: (err) => log.debug({ err }, "walk error") })) {
        const rel = relative(root, e.path);
        if (!passesGlobs(rel, e.path.split("/").pop() ?? "", args.include, args.exclude)) {
            continue;
        }

        const parts = dirname(rel) === "." ? [] : dirname(rel).split("/");
        if (args.maxDepth !== undefined && parts.length > args.maxDepth) {
            continue;
        }

        const priv = getPrivateSize(e.path);
        let node = rootNode;
        node.logical += e.logical;
        node.allocated += e.allocated;
        if (priv !== null) {
            node.real = (node.real ?? 0) + priv;
            node.realSeen = true;
        }

        let acc = root;
        let depth = 0;
        for (const part of parts) {
            acc = `${acc}/${part}`;
            depth += 1;
            let child = node.children.get(part);
            if (!child) {
                child = emptyNode(acc, depth);
                node.children.set(part, child);
            }

            child.logical += e.logical;
            child.allocated += e.allocated;
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
        },
    ];
}

function buildCloneAnalysis(roots: string[]): CloneAnalysis {
    let families = 0;
    let clonedFiles = 0;
    const partners = new Set<string>();
    for (const root of roots) {
        const fams = findCloneFamilies(root);
        families += fams.size;
        for (const members of fams.values()) {
            clonedFiles += members.length;
            for (const m of members) {
                if (!roots.some((r) => m.startsWith(r))) {
                    partners.add(dirname(m));
                }
            }
        }
    }

    return {
        families,
        clonedFiles,
        sharedBytes: 0,
        crossTreePartners: [...partners],
        notes: [],
    };
}

function sortTree(nodes: DirNode[], by: "overcount" | "real" | "du"): DirNode[] {
    const key = (n: DirNode): number =>
        by === "real" ? (n.real ?? -1) : by === "du" ? n.allocated : (n.overcount ?? -1);
    return [...nodes].sort((a, b) => key(b) - key(a)).map((n) => ({ ...n, children: sortTree(n.children, by) }));
}

export function buildMeasureReport(args: BuildMeasureArgs): MeasureReport {
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

    for (const root of args.roots) {
        const u = measureTree(root);
        totalsAgg.logical += u.logical;
        totalsAgg.allocated += u.allocated;
        if (u.private !== null) {
            realSeen = true;
            totalsAgg.private = (totalsAgg.private ?? 0) + u.private;
        }

        totalsAgg.errors.push(...u.errors);

        if (args.breakdown) {
            const rootMut = buildRootTree(root, args);
            tree.push(...pruneTree(rootMut, args.minReal));
        }
    }

    const totalReal = realSeen ? totalsAgg.private : null;
    const totalOvercount = totalReal !== null && totalReal > 0 ? totalsAgg.allocated / totalReal : null;
    const fs = freeDiskSpace(args.roots[0]);
    const sorted = args.breakdown ? sortTree(tree, args.sort ?? "overcount") : [];

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
        cloneAnalysis: buildCloneAnalysis(args.roots),
        freeSpace: { total: fs.total, free: fs.free, available: fs.available },
        errors: totalsAgg.errors.map((e) => ({ path: e.path, errno: e.errno })),
    };
}
