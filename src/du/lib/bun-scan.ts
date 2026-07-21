// Independent Bun engine: an FFI + Worker-pool reimplementation of the C engine,
// producing a byte-for-byte identical ClonesizeResult. Kept independent on
// purpose so `bench` can cross-check the two implementations against each other.
//
// The dedup/merge/cluster math below is a faithful port of native/clonesize.c —
// if you change one, change both, or the cross-check will (correctly) fail.

import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureShim } from "./engine";
import type { ClonesizeResult, GroupResult, ScanOptions } from "./types";

const MAX_GROUPS = 64;

interface WorkerResult {
    devs: BigUint64Array;
    lens: BigUint64Array;
    grps: Int32Array;
    naive: string;
    scanned: number;
    gNaive: Float64Array;
    gFiles: Float64Array;
}

/** Walk the tree, assigning each file the group of its top-level component. */
function walk(root: string, excludes: Set<string>): { paths: string[]; groups: number[]; groupNames: string[] } {
    const paths: string[] = [];
    const groups: number[] = [];
    const groupNames: string[] = [];
    const groupIndex = new Map<string, number>();

    const intern = (name: string): number => {
        const found = groupIndex.get(name);
        if (found !== undefined) {
            return found;
        }
        const idx = groupNames.length >= MAX_GROUPS ? MAX_GROUPS - 1 : groupNames.length;
        if (groupNames.length < MAX_GROUPS) {
            groupNames.push(name);
            groupIndex.set(name, idx);
        }
        return idx;
    };

    const recurse = (dir: string, group: number) => {
        let entries: Dirent<string>[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const name = e.name;
            if (name === "." || name === "..") {
                continue;
            }
            const p = join(dir, name);
            if (excludes.has(p)) {
                continue;
            }
            const g = group < 0 ? intern(name) : group;
            if (e.isDirectory()) {
                recurse(p, g);
            } else if (e.isFile()) {
                paths.push(p);
                groups.push(g);
            } else if (e.isSymbolicLink()) {
                // skip; du doesn't follow symlinks by default
            } else {
                // unknown type — stat to classify
                try {
                    const st = statSync(p);
                    if (st.isDirectory()) {
                        recurse(p, g);
                    } else if (st.isFile()) {
                        paths.push(p);
                        groups.push(g);
                    }
                } catch {
                    /* ignore */
                }
            }
        }
    };

    recurse(root, -1);
    return { paths, groups, groupNames };
}

export async function scanWithBun(opts: ScanOptions): Promise<ClonesizeResult> {
    const root = resolve(opts.path);
    const shim = ensureShim();
    const excludes = new Set((opts.exclude ?? []).map((p) => resolve(p)));

    const { paths, groups, groupNames } = walk(root, excludes);
    const ngroups = groupNames.length;

    let nthreads = opts.threads && opts.threads > 0 ? opts.threads : navigator.hardwareConcurrency || 8;
    if (nthreads > paths.length && paths.length > 0) {
        nthreads = paths.length;
    }
    if (nthreads < 1) {
        nthreads = 1;
    }

    const per = Math.ceil(paths.length / nthreads);
    const workerURL = new URL("./scan-worker.ts", import.meta.url);

    const runSlice = (start: number, end: number): Promise<WorkerResult> =>
        new Promise((resolvePromise, reject) => {
            const worker = new Worker(workerURL);
            const slicePaths = paths.slice(start, end);
            const sliceGroups = Int32Array.from(groups.slice(start, end));
            worker.onmessage = (ev: MessageEvent<WorkerResult>) => {
                resolvePromise(ev.data);
                worker.terminate();
            };
            worker.onerror = (err) => {
                reject(err);
                worker.terminate();
            };
            worker.postMessage(
                { shim, paths: slicePaths, groups: sliceGroups, ngroups, minBytes: opts.minBytes ?? 0 },
                [sliceGroups.buffer]
            );
        });

    const slices: Promise<WorkerResult>[] = [];
    for (let i = 0; i < nthreads; i++) {
        const start = Math.min(i * per, paths.length);
        const end = Math.min(start + per, paths.length);
        slices.push(runSlice(start, end));
    }
    const results = await Promise.all(slices);

    // ---- merge worker outputs ----
    let totalExts = 0;
    let scanned = 0;
    let naive = 0n;
    const gNaive = new Array<number>(ngroups).fill(0);
    const gFiles = new Array<number>(ngroups).fill(0);
    for (const r of results) {
        totalExts += r.devs.length;
        scanned += r.scanned;
        naive += BigInt(r.naive);
        for (let g = 0; g < ngroups; g++) {
            gNaive[g]! += r.gNaive[g] ?? 0;
            gFiles[g]! += r.gFiles[g] ?? 0;
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

    // sort indices by device offset (stable-enough; ties don't matter for merge)
    const idx = new Uint32Array(totalExts);
    for (let i = 0; i < totalExts; i++) {
        idx[i] = i;
    }
    const idxArr = Array.from(idx);
    idxArr.sort((a, b) => {
        const da = devs[a]!;
        const db = devs[b]!;
        return da < db ? -1 : da > db ? 1 : 0;
    });

    // merge overlapping clusters, track group bitmask (BigInt for up to 64 groups)
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

    let unique = 0n;
    let crossShared = 0n;
    const groupShared = new Array<bigint>(ngroups).fill(0n);

    let i = 0;
    while (i < totalExts) {
        const e0 = idxArr[i]!;
        let ce = devs[e0]! + lens[e0]!;
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
        const cs = devs[e0]!;
        const clen = ce - cs;
        unique += clen;

        // popcount
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
    const uniqueNum = Number(unique);
    const shared = naiveNum > uniqueNum ? naiveNum - uniqueNum : 0;
    const pct = naiveNum ? (100 * shared) / naiveNum : 0;

    const groupsOut: GroupResult[] = [];
    for (let g = 0; g < ngroups; g++) {
        if (gNaive[g]! === 0) {
            continue;
        }
        const gn = gNaive[g]!;
        const gs = Number(groupShared[g]!);
        groupsOut.push({
            name: groupNames[g]!,
            naive_bytes: gn,
            files: gFiles[g]!,
            cross_group_shared_bytes: gs,
            shared_pct: gn ? Number(((100 * gs) / gn).toFixed(2)) : 0,
            clone_cluster: find(g),
            clone_flagged: gs >= 0.3 * gn && gs > 0,
        });
    }

    return {
        path: opts.path,
        files_scanned: scanned,
        files_listed: paths.length,
        extents: totalExts,
        threads: nthreads,
        naive_bytes: naiveNum,
        unique_bytes: uniqueNum,
        shared_bytes: shared,
        shared_pct: Number(pct.toFixed(2)),
        cross_group_shared_bytes: Number(crossShared),
        groups: groupsOut,
    };
}
