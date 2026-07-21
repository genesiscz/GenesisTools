// Bun Worker: scans a slice of the file list via the non-variadic fcntl shim
// (l2p_ext) and returns raw physical extents. Real OS thread => open()/fcntl()
// on this slice run in true parallel with the other workers, which is what makes
// the Bun engine competitive on syscall-bound clonefile trees.
//
// NOTE: fcntl(F_LOG2PHYS_EXT) is variadic; on Apple arm64 bun:ffi mis-passes the
// variadic pointer, so we call a fixed-signature C shim (native/l2p_shim.c ->
// libl2pshim.dylib) instead. See native/clonesize.c header for the method.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, fstatSync, openSync } from "node:fs";

declare const self: Worker;

interface InMsg {
    shim: string;
    paths: string[];
    groups: Int32Array;
    ngroups: number;
    minBytes: number;
}

self.onmessage = (ev: MessageEvent<InMsg>) => {
    const { shim, paths, groups, ngroups, minBytes } = ev.data;

    const lib = dlopen(shim, {
        l2p_ext: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    const l2p = lib.symbols.l2p_ext;

    // struct log2phys, pack(4), 20 bytes: flags@0, contigbytes@4, devoffset@12
    const buf = new Uint8Array(20);
    const dv = new DataView(buf.buffer);
    const bp = ptr(buf);

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
    let scanned = 0;
    const gNaive = new Float64Array(ngroups);
    const gFiles = new Float64Array(ngroups);
    const HOLE = 0xffffffffffffffffn; // (off_t)-1 as unsigned

    for (let i = 0; i < paths.length; i++) {
        const path = paths[i]!;
        const group = groups[i]!;
        let fd: number;
        try {
            fd = openSync(path, "r");
        } catch {
            continue;
        }
        try {
            const st = fstatSync(fd, { bigint: true });
            const bytes = st.blocks * 512n;
            if (bytes === 0n || bytes < BigInt(minBytes)) {
                continue;
            }
            naive += bytes;
            gNaive[group]! += Number(bytes);
            gFiles[group]! += 1;
            scanned++;

            const size = st.size;
            let off = 0n;
            while (off < size) {
                dv.setUint32(0, 0, true);
                dv.setBigInt64(4, size - off, true); // IN contigbytes
                dv.setBigInt64(12, off, true); // IN file offset
                if (l2p(fd, bp) < 0) {
                    break;
                }
                const contig = dv.getBigInt64(4, true);
                const devoff = dv.getBigUint64(12, true);
                if (contig <= 0n) {
                    break;
                }
                if (devoff !== HOLE) {
                    push(devoff, BigInt(contig), group);
                }
                off += contig;
            }
        } finally {
            closeSync(fd);
        }
    }

    lib.close();

    // Trim to exact length and transfer the underlying buffers.
    const devOut = devs.slice(0, n);
    const lenOut = lens.slice(0, n);
    const grpOut = grps.slice(0, n);
    self.postMessage(
        {
            devs: devOut,
            lens: lenOut,
            grps: grpOut,
            naive: naive.toString(),
            scanned,
            gNaive,
            gFiles,
        },
        [devOut.buffer, lenOut.buffer, grpOut.buffer, gNaive.buffer, gFiles.buffer]
    );
};
