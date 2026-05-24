/**
 * Throwaway smoke test for `getattrlistbulk(2)` via `bun:ffi`. Goal:
 * before integrating into `src/utils/fs/walkFiles`, verify that the
 * kernel actually returns the (NAME, OBJTYPE, MODTIME, FILEID, ERROR,
 * TOTALSIZE, CLONEID) tuple we need, in the layout we expect, and that
 * `ATTR_CMNEXT_CLONEID` actually carries the APFS clone family id.
 *
 * Usage:
 *   bun scripts/benchmarks/clones/microbenches/apfs-smoke-getattrlistbulk.ts <dir>
 *
 * Exits 0 on a successful walk. Prints each entry's (name, type, size,
 * mtime_ns, fileid, cloneid, error) as JSON, one per line.
 */

import { dlopen, FFIType, ptr, read } from "bun:ffi";

const dir = process.argv[2];
if (!dir) {
    console.error("usage: <dir>");
    process.exit(2);
}

const lib = dlopen("libSystem.dylib", {
    getattrlistbulk: {
        args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
    },
    open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
});

const ATTR_BIT_MAP_COUNT = 5;
const ATTR_CMN_NAME = 0x00000001;
const ATTR_CMN_OBJTYPE = 0x00000008;
const ATTR_CMN_MODTIME = 0x00000400;
const ATTR_CMN_FILEID = 0x02000000;
const ATTR_CMN_ERROR = 0x20000000;
const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_FILE_TOTALSIZE = 0x00000002;
const ATTR_CMNEXT_CLONEID = 0x00000100;
const FSOPT_PACK_INVAL_ATTRS = 0x00000008;
const FSOPT_ATTR_CMN_EXTENDED = 0x00000020;

const O_RDONLY = 0;
const O_DIRECTORY = 0x100000;

const VREG = 1;
const VDIR = 2;
const VLNK = 5;

// attrlist struct: 24 bytes total (1 u16 + 1 u16 reserved + 5 u32).
const attrlist = new ArrayBuffer(24);
const al = new DataView(attrlist);
al.setUint16(0, ATTR_BIT_MAP_COUNT, true);
al.setUint16(2, 0, true);
al.setUint32(
    4,
    ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE | ATTR_CMN_MODTIME | ATTR_CMN_FILEID | ATTR_CMN_ERROR,
    true
);
al.setUint32(8, 0, true);
al.setUint32(12, 0, true);
al.setUint32(16, ATTR_FILE_TOTALSIZE, true);
al.setUint32(20, ATTR_CMNEXT_CLONEID, true);

const cPath = Buffer.from(`${dir}\0`);
const fd = lib.symbols.open(cPath, O_RDONLY | O_DIRECTORY);
if (fd < 0) {
    console.error(`open(${dir}) failed`);
    process.exit(1);
}

const BUF_BYTES = 128 * 1024;
const buf = new ArrayBuffer(BUF_BYTES);
const bufPtr = ptr(buf);
const view = new DataView(buf);
const bufU8 = new Uint8Array(buf);
const opts = BigInt(FSOPT_ATTR_CMN_EXTENDED | FSOPT_PACK_INVAL_ATTRS);

const decoder = new TextDecoder();
let totalEntries = 0;
let totalSyscalls = 0;
const start = performance.now();

while (true) {
    const n = lib.symbols.getattrlistbulk(fd, ptr(attrlist), bufPtr, BigInt(BUF_BYTES), opts);
    totalSyscalls += 1;
    if (n < 0) {
        const errnoPtr = lib.symbols.__error();
        const errno = errnoPtr ? read.i32(Number(errnoPtr)) : -1;
        console.error(`getattrlistbulk failed, errno=${errno}`);
        lib.symbols.close(fd);
        process.exit(1);
    }

    if (n === 0) {
        break;
    }

    let off = 0;
    for (let i = 0; i < n; i++) {
        const entryStart = off;
        const entryLen = view.getUint32(off, true);
        off += 4;
        // returned_attrs (attribute_set_t = 5 × u32 = 20 bytes) — always FIRST
        // when ATTR_CMN_RETURNED_ATTRS is requested.
        const returnedCommon = view.getUint32(off, true);
        off += 4;
        const returnedVol = view.getUint32(off, true);
        off += 4;
        const returnedDir = view.getUint32(off, true);
        off += 4;
        const returnedFile = view.getUint32(off, true);
        off += 4;
        const returnedFork = view.getUint32(off, true);
        off += 4;
        // ATTR_CMN_ERROR is packed FIRST after returned_attrs in the bulk
        // variant (man getattrlistbulk: "Returns errno for entry. Required for
        // bulk-mode; always packed at the START of variable data").
        const errorCode = view.getUint32(off, true);
        off += 4;
        // NAME attrreference_t — attr_dataoffset is relative to the start
        // of THIS attrreference, attr_length includes the trailing NUL.
        const nameRefStart = off;
        const nameOffset = view.getInt32(off, true);
        off += 4;
        const nameLength = view.getUint32(off, true);
        off += 4;
        // OBJTYPE (u32 fsobj_type_t: VREG=1, VDIR=2, VLNK=5, …)
        const objtype = view.getUint32(off, true);
        off += 4;
        // MODTIME timespec (i64 sec, i64 nsec) — 16 bytes
        const sec = view.getBigInt64(off, true);
        off += 8;
        const nsec = view.getBigInt64(off, true);
        off += 8;
        // FILEID (u64)
        const fileid = view.getBigUint64(off, true);
        off += 8;
        // TOTALSIZE (off_t = i64) — fileattr group
        const totalsize = view.getBigInt64(off, true);
        off += 8;
        // CLONEID (u64) — forkattr (reinterpreted as cmnext)
        const cloneid = view.getBigUint64(off, true);
        off += 8;

        const nameBytes = bufU8.subarray(nameRefStart + nameOffset, nameRefStart + nameOffset + nameLength - 1);
        const name = decoder.decode(nameBytes);

        const mtimeNs = sec * 1000000000n + nsec;
        const entry = {
            name,
            objtype: objtype === VREG ? "REG" : objtype === VDIR ? "DIR" : objtype === VLNK ? "LNK" : `T${objtype}`,
            totalsize: totalsize.toString(),
            mtimeNs: mtimeNs.toString(),
            fileid: fileid.toString(),
            cloneid: cloneid.toString(16),
            error: errorCode,
            returnedBits: {
                cmn: `0x${returnedCommon.toString(16)}`,
                file: `0x${returnedFile.toString(16)}`,
                fork: `0x${returnedFork.toString(16)}`,
            },
        };
        console.log(JSON.stringify(entry));
        // Skip to the next entry. We've read 4+20+8+4+16+8+4+8+8 = 80 bytes
        // of fixed fields + variable name. The name is referenced by the
        // attrreference (which sits at offset 24-32 of the entry), so the
        // name bytes may live BEFORE we're currently at. The entryLen
        // tells us the total span — use it to advance.
        off = entryStart + entryLen;
        totalEntries += 1;
        // Suppress vol/dir to silence biome unused-var lint
        void returnedVol;
        void returnedDir;
    }
}

lib.symbols.close(fd);
const elapsed = performance.now() - start;
console.error(`[smoke] ${totalEntries} entries in ${totalSyscalls} syscalls (${elapsed.toFixed(1)}ms)`);
