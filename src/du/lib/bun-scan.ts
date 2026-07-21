// Independent Bun engine: a pure-TypeScript + bun:ffi reimplementation of the C
// engine (native/clonesize.c), producing a byte-for-byte identical
// ClonesizeResult. Kept independent on purpose so `bench` can cross-check the two.
//
// Same algorithm as the C core: the main thread does a cheap readdir pass to
// enumerate every directory (and intern the top-level groups), then distributes
// the directories round-robin across Bun Workers. Each worker runs the shared
// bun:ffi scan core (ffi-scan.ts): getattrlistbulk gives each file's
// alloc/datalength/privatesize without opening it; fully-private single-link
// non-sparse files are counted as unique via datalength; only sharers are opened
// and extent-scanned. The merge/dedup/cluster math below matches the C engine.

import { type Dirent, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { profiler } from "@genesiscz/utils/profile";
import { ensureShim } from "./engine";
import { type ScanDirsInput, type ScanDirsResult, scanDirs } from "./ffi-scan";
import type { ClonesizeResult, GroupResult, ScanOptions } from "./types";

// Group-count cap (mirrors native/clonesize.c). Cross-group sharing uses a BigInt
// mask (no 64-bit limit); this is just the intern ceiling — generous so a scan root
// with many immediate children (>64) never folds into a bogus overflow bucket.
const MAX_GROUPS = 4096;
const prof = profiler.scope("du.bun");

/**
 * A shallow, bounded breadth-first split of the tree. Intern the top-level groups,
 * then expand level by level until we have enough "frontier" directories to keep
 * every worker busy. Interior dirs (whose subtrees were split off) get their DIRECT
 * files scanned non-recursively; frontier dirs are recursed by the workers. This
 * keeps the main thread's readdir work tiny (a few hundred dirs) — the deep,
 * expensive part of the walk happens in parallel inside the workers.
 */
function planWork(
    root: string,
    excludes: Set<string>,
    target: number
): { frontier: string[]; interior: string[]; groupIndex: Map<string, number>; groupNames: string[] } {
    const groupNames: string[] = [];
    const groupIndex = new Map<string, number>();
    const intern = (name: string): void => {
        if (groupIndex.has(name)) {
            return;
        }
        if (groupNames.length < MAX_GROUPS) {
            groupNames.push(name);
            groupIndex.set(name, groupNames.length - 1);
        } else {
            groupIndex.set(name, MAX_GROUPS - 1);
        }
    };

    const subDirs = (dir: string): string[] => {
        let entries: Dirent<string>[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return [];
        }
        const out: string[] = [];
        for (const e of entries) {
            if (!e.isDirectory()) {
                continue;
            }
            const p = join(dir, e.name);
            if (!excludes.has(p)) {
                out.push(p);
            }
        }
        return out;
    };

    // Every immediate child of root (file OR dir) is a group.
    for (const e of readdirSync(root, { withFileTypes: true })) {
        if (!excludes.has(join(root, e.name))) {
            intern(e.name);
        }
    }

    const interior: string[] = [root];
    let frontier: string[] = subDirs(root);

    // Expand the frontier level by level until it is large enough to balance.
    while (frontier.length < target) {
        const next: string[] = [];
        let expanded = false;
        for (const d of frontier) {
            const subs = subDirs(d);
            if (subs.length > 0) {
                interior.push(d);
                for (const s of subs) {
                    next.push(s);
                }
                expanded = true;
            } else {
                next.push(d); // leaf dir — nothing to split
            }
        }
        if (!expanded) {
            break;
        }
        frontier = next;
    }

    return { frontier, interior, groupIndex, groupNames };
}

export async function scanWithBun(opts: ScanOptions): Promise<ClonesizeResult> {
    const root = resolve(opts.path);
    const shim = ensureShim();
    const excludes = new Set((opts.exclude ?? []).map((p) => resolve(p)));

    let nthreads = opts.threads && opts.threads > 0 ? opts.threads : navigator.hardwareConcurrency || 8;
    if (nthreads < 1) {
        nthreads = 1;
    }

    const endPlan = prof.start("plan(bfs)");
    // Expand the frontier well past the worker count so giant subtrees (a whole
    // node_modules) get split into many small frontier dirs — otherwise one worker
    // inherits the whole thing and everyone else idles.
    const { frontier, interior, groupIndex, groupNames } = planWork(root, excludes, nthreads * 256);
    endPlan();
    const ngroups = groupNames.length;
    const excludeList = [...excludes];

    // Round-robin the frontier directories across workers to balance load.
    const nBuckets = Math.min(nthreads, Math.max(1, frontier.length));
    const buckets: string[][] = Array.from({ length: nBuckets }, () => []);
    for (let i = 0; i < frontier.length; i++) {
        buckets[i % nBuckets]!.push(frontier[i]!);
    }

    const workerURL = new URL("./scan-worker.ts", import.meta.url);
    const runBucket = (dirsForWorker: string[]): Promise<ScanDirsResult> =>
        new Promise((resolvePromise, reject) => {
            const worker = new Worker(workerURL);
            worker.onmessage = (ev: MessageEvent<ScanDirsResult>) => {
                resolvePromise(ev.data);
                worker.terminate();
            };
            worker.onerror = (err) => {
                reject(err);
                worker.terminate();
            };
            const msg: ScanDirsInput = {
                shim,
                root,
                dirs: dirsForWorker,
                recurse: true,
                excludes: excludeList,
                groupIndex,
                ngroups,
                minBytes: opts.minBytes ?? 0,
                freeable: !!opts.freeable,
            };
            worker.postMessage(msg);
        });

    // Workers recurse the frontier; meanwhile the main thread scans the interior
    // dirs' direct files (non-recursive) — the two run concurrently.
    const endScan = prof.start("workers+interior");
    const workerPromises = buckets.map(runBucket);
    const interiorResult = scanDirs({
        shim,
        root,
        dirs: interior,
        recurse: false,
        excludes: excludeList,
        groupIndex,
        ngroups,
        minBytes: opts.minBytes ?? 0,
        freeable: !!opts.freeable,
    });
    const results = [interiorResult, ...(await Promise.all(workerPromises))];
    endScan();

    const endMerge = prof.start("merge");
    // ---- merge worker outputs ----
    let totalExts = 0;
    let scanned = 0;
    let listed = 0;
    let opened = 0;
    let naive = 0n;
    let uniquePrivate = 0n;
    let privSum = 0n;
    const gNaive = new Array<number>(ngroups).fill(0);
    const gFiles = new Array<number>(ngroups).fill(0);
    const gPrivate = new Array<number>(ngroups).fill(0);
    for (const r of results) {
        totalExts += r.devs.length;
        scanned += r.scanned;
        listed += r.listed;
        opened += r.opened;
        naive += BigInt(r.naive);
        uniquePrivate += BigInt(r.uniquePrivate);
        privSum += BigInt(r.privSum);
        for (let g = 0; g < ngroups; g++) {
            gNaive[g]! += r.gNaive[g] ?? 0;
            gFiles[g]! += r.gFiles[g] ?? 0;
            gPrivate[g]! += r.gPrivate[g] ?? 0;
        }
    }

    const devs = new BigUint64Array(totalExts);
    const lens = new BigUint64Array(totalExts);
    const grps = new Int32Array(totalExts);
    let k = 0;
    for (const r of results) {
        devs.set(r.devs, k);
        lens.set(r.lens, k);
        grps.set(r.grps, k);
        k += r.devs.length;
    }

    // sort indices by device offset
    const idxArr = Array.from({ length: totalExts }, (_v, i) => i);
    idxArr.sort((a, b) => {
        const da = devs[a]!;
        const db = devs[b]!;
        return da < db ? -1 : da > db ? 1 : 0;
    });

    // merge overlapping clusters, track group bitmask
    const uf = new Int32Array(MAX_GROUPS);
    for (let i = 0; i < MAX_GROUPS; i++) {
        uf[i] = i;
    }
    const find = (x: number): number => {
        while (uf[x] !== x) {
            uf[x] = uf[uf[x]!]!;
            x = uf[x]!;
        }
        return x;
    };
    const union = (a: number, b: number) => {
        a = find(a);
        b = find(b);
        if (a !== b) {
            uf[a] = b;
        }
    };

    let uniqueShared = 0n;
    let crossShared = 0n;
    const groupShared = new Array<bigint>(ngroups).fill(0n);

    let i = 0;
    while (i < totalExts) {
        const e0 = idxArr[i]!;
        const cs = devs[e0]!;
        let ce = cs + lens[e0]!;
        let mask = 1n << BigInt(grps[e0]!);
        let j = i + 1;
        while (j < totalExts) {
            const ej = idxArr[j]!;
            if (devs[ej]! > ce) {
                break;
            }
            const en = devs[ej]! + lens[ej]!;
            if (en > ce) {
                ce = en;
            }
            mask |= 1n << BigInt(grps[ej]!);
            j++;
        }
        const clen = ce - cs;
        uniqueShared += clen;

        let pc = 0;
        let m = mask;
        while (m > 0n) {
            pc += Number(m & 1n);
            m >>= 1n;
        }
        if (pc > 1) {
            crossShared += clen;
            let first = -1;
            for (let g = 0; g < ngroups && g < MAX_GROUPS; g++) {
                if ((mask & (1n << BigInt(g))) !== 0n) {
                    groupShared[g]! += clen;
                    if (first < 0) {
                        first = g;
                    } else {
                        union(first, g);
                    }
                }
            }
        }
        i = j;
    }

    const naiveNum = Number(naive);
    const uniqueNum = Number(uniquePrivate + uniqueShared);
    const shared = naiveNum > uniqueNum ? naiveNum - uniqueNum : 0;
    const pct = naiveNum ? (100 * shared) / naiveNum : 0;

    const groupsOut: GroupResult[] = [];
    for (let g = 0; g < ngroups; g++) {
        if (gNaive[g]! === 0) {
            continue;
        }
        const gn = gNaive[g]!;
        const gs = Number(groupShared[g]!);
        const group: GroupResult = {
            name: groupNames[g]!,
            naive_bytes: gn,
            files: gFiles[g]!,
            cross_group_shared_bytes: gs,
            shared_pct: gn ? Number(((100 * gs) / gn).toFixed(2)) : 0,
            clone_cluster: find(g),
            clone_flagged: gs >= 0.3 * gn && gs > 0,
        };
        if (opts.freeable) {
            group.private_bytes = gPrivate[g]!;
        }
        groupsOut.push(group);
    }

    const result: ClonesizeResult = {
        path: opts.path,
        files_scanned: scanned,
        files_listed: listed,
        files_opened: opened,
        extents: totalExts,
        threads: nthreads,
        naive_bytes: naiveNum,
        unique_bytes: uniqueNum,
        shared_bytes: shared,
        shared_pct: Number(pct.toFixed(2)),
        cross_group_shared_bytes: Number(crossShared),
        groups: groupsOut,
    };
    if (opts.freeable) {
        result.private_sum_bytes = Number(privSum);
    }

    endMerge();
    prof.summary("bun engine");
    return result;
}
