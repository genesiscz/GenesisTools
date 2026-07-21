// Shared bun:ffi scan core for the Bun engine — a faithful port of the C
// algorithm (native/clonesize.c): per directory, one getattrlistbulk pass yields
// each file's linkcount/allocsize/datalength/privatesize WITHOUT opening it;
// fully-private single-link non-sparse files are counted as unique via their
// datalength (no open); only files that share blocks are opened + extent-scanned
// via the fcntl shim. Used by scan-worker.ts (one instance per Bun Worker).

import { dlopen, FFIType, ptr } from "bun:ffi";

const VREG = 1;
const VDIR = 2;
const HOLE = 0xffffffffffffffffn; // (off_t)-1 as unsigned

export interface ScanDirsInput {
    /** Path to libl2pshim.dylib. */
    shim: string;
    /** Scan root (used to derive each file's top-level group). */
    root: string;
    /** Directories this worker owns. */
    dirs: string[];
    /** When true, recurse into every subdirectory found (frontier roots); when
     * false, process only the given dirs' direct files (interior dirs). */
    recurse: boolean;
    /** Absolute directory subtrees to prune (only consulted when recursing). */
    excludes: string[];
    /** Top-level-name → group index (interned by the main thread). */
    groupIndex: Map<string, number>;
    ngroups: number;
    minBytes: number;
    /** Also accumulate per-file privatesize (for --freeable). */
    freeable: boolean;
}

export interface ScanDirsResult {
    devs: BigUint64Array;
    lens: BigUint64Array;
    grps: Int32Array;
    naive: string;
    uniquePrivate: string;
    privSum: string;
    scanned: number; // files accounted (alloc>0 && >=min)
    listed: number; // all regular files seen
    opened: number; // shared files opened + scanned
    gNaive: Float64Array;
    gFiles: Float64Array;
    gPrivate: Float64Array;
}

const MAX_GROUPS = 4096; // mirrors native/clonesize.c; BigInt mask has no 64-bit limit

export function scanDirs(input: ScanDirsInput): ScanDirsResult {
    const { shim, root, dirs, recurse, groupIndex, ngroups, minBytes } = input;
    const excludeSet = new Set(input.excludes);

    const lib = dlopen(shim, {
        l2p_ext: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        cs_opendir_fd: { args: [FFIType.ptr], returns: FFIType.i32 },
        cs_openat_file: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        cs_close: { args: [FFIType.i32], returns: FFIType.i32 },
        cs_getattrbulk: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    const { l2p_ext, cs_opendir_fd, cs_openat_file, cs_close, cs_getattrbulk } = lib.symbols;

    // getattrlistbulk output buffer.
    const BUF_SIZE = 64 * 1024;
    const abuf = new Uint8Array(BUF_SIZE);
    const abufPtr = ptr(abuf);
    const adv = new DataView(abuf.buffer);

    // struct log2phys (pack(4), 20 bytes).
    const lbuf = new Uint8Array(20);
    const ldv = new DataView(lbuf.buffer);
    const lbufPtr = ptr(lbuf);

    let cap = 8192;
    let devs = new BigUint64Array(cap);
    let lens = new BigUint64Array(cap);
    let grps = new Int32Array(cap);
    let n = 0;
    const push = (d: bigint, l: bigint, g: number) => {
        if (n === cap) {
            cap *= 2;
            const nd = new BigUint64Array(cap);
            nd.set(devs);
            devs = nd;
            const nl = new BigUint64Array(cap);
            nl.set(lens);
            lens = nl;
            const ng = new Int32Array(cap);
            ng.set(grps);
            grps = ng;
        }
        devs[n] = d;
        lens[n] = l;
        grps[n] = g;
        n++;
    };

    let naive = 0n;
    let uniquePrivate = 0n;
    let privSum = 0n;
    let scanned = 0;
    let listed = 0;
    let opened = 0;
    const gNaive = new Float64Array(ngroups);
    const gFiles = new Float64Array(ngroups);
    const gPrivate = new Float64Array(ngroups);
    const minB = BigInt(minBytes);

    const rootPrefixLen = root.length + 1;
    const groupOf = (fullPath: string): number => {
        const rel = fullPath.slice(rootPrefixLen);
        const slash = rel.indexOf("/");
        const top = slash < 0 ? rel : rel.slice(0, slash);
        return groupIndex.get(top) ?? MAX_GROUPS - 1;
    };

    const dec = new TextDecoder();
    const readName = (nameByteOff: number): string => {
        let end = nameByteOff;
        while (abuf[end] !== 0) {
            end++;
        }
        return dec.decode(abuf.subarray(nameByteOff, end));
    };

    const stack = [...dirs];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        const dirBuf = Buffer.from(`${dir}\0`, "utf8");
        const dfd = cs_opendir_fd(ptr(dirBuf));
        if (dfd < 0) {
            continue;
        }
        // Precompute group for non-root dirs (all their files share it).
        const dirIsRoot = dir === root;
        const dirGroup = dirIsRoot ? -1 : groupOf(`${dir}/x`);

        for (;;) {
            const cnt = cs_getattrbulk(dfd, abufPtr, BigInt(BUF_SIZE));
            if (cnt <= 0) {
                break;
            }
            let p = 0;
            for (let e = 0; e < cnt; e++) {
                const len = adv.getUint32(p, true);
                const nameOff = adv.getInt32(p + 24, true);
                const objtype = adv.getUint32(p + 32, true);
                const nlink = adv.getUint32(p + 36, true);
                const alloc = adv.getBigInt64(p + 40, true);
                const dlen = adv.getBigInt64(p + 48, true);
                const priv = adv.getBigInt64(p + 56, true);
                const nameByteOff = p + 24 + nameOff;

                if (objtype === VDIR) {
                    if (recurse) {
                        const sub = `${dir}/${readName(nameByteOff)}`;
                        if (!excludeSet.has(sub)) {
                            stack.push(sub);
                        }
                    }
                    p += len;
                    continue;
                }
                if (objtype !== VREG) {
                    p += len;
                    continue;
                }

                listed++;
                privSum += priv;

                if (alloc === 0n || alloc < minB) {
                    p += len;
                    continue;
                }

                // Resolve group: root files vary per-name; deep files share dirGroup.
                let group: number;
                if (dirIsRoot) {
                    group = groupIndex.get(readName(nameByteOff)) ?? MAX_GROUPS - 1;
                } else {
                    group = dirGroup;
                }

                naive += alloc;
                gNaive[group]! += Number(alloc);
                gFiles[group]! += 1;
                gPrivate[group]! += Number(priv);
                scanned++;

                if (priv >= alloc && nlink <= 1 && alloc >= dlen) {
                    uniquePrivate += dlen; // fully private, non-sparse, single link
                    p += len;
                    continue;
                }

                // Shares blocks (or hardlinked/sparse) — open by leaf + extent-scan.
                const ffd = cs_openat_file(dfd, ptr(abuf, nameByteOff));
                if (ffd >= 0) {
                    opened++;
                    let off = 0n;
                    while (off < dlen) {
                        ldv.setUint32(0, 0, true);
                        ldv.setBigInt64(4, dlen - off, true); // IN contigbytes
                        ldv.setBigInt64(12, off, true); // IN file offset
                        if (l2p_ext(ffd, lbufPtr) < 0) {
                            break;
                        }
                        const contig = ldv.getBigInt64(4, true);
                        const devoff = ldv.getBigUint64(12, true);
                        if (contig <= 0n) {
                            break;
                        }
                        if (devoff !== HOLE) {
                            push(devoff, contig, group);
                        }
                        off += contig;
                    }
                    cs_close(ffd);
                }
                p += len;
            }
        }
        cs_close(dfd);
    }

    lib.close();

    return {
        devs: devs.slice(0, n),
        lens: lens.slice(0, n),
        grps: grps.slice(0, n),
        naive: naive.toString(),
        uniquePrivate: uniquePrivate.toString(),
        privSum: privSum.toString(),
        scanned,
        listed,
        opened,
        gNaive,
        gFiles,
        gPrivate,
    };
}
