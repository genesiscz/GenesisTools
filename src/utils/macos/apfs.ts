import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

const IS_DARWIN = process.platform === "darwin";

// All values verified against apple/darwin-xnu (Task 1, gh_grep).
// apple/darwin-xnu bsd/sys/attr.h:96  #define ATTR_BIT_MAP_COUNT 5
const ATTR_BIT_MAP_COUNT = 5;
// apple/darwin-xnu bsd/sys/attr.h:531  #define ATTR_CMNEXT_PRIVATESIZE 0x00000008
const ATTR_CMNEXT_PRIVATESIZE = 0x00000008;
// apple/darwin-xnu bsd/sys/attr.h:537  #define ATTR_CMNEXT_CLONEID     0x00000100
const ATTR_CMNEXT_CLONEID = 0x00000100;
// apple/darwin-xnu bsd/sys/attr.h:538  #define ATTR_CMNEXT_EXT_FLAGS   0x00000200
const ATTR_CMNEXT_EXT_FLAGS = 0x00000200;
// apple/darwin-xnu bsd/sys/attr.h:54   #define FSOPT_ATTR_CMN_EXTENDED 0x00000020
const FSOPT_ATTR_CMN_EXTENDED = 0x00000020;
// apple/darwin-xnu bsd/sys/attr.h:46   #define FSOPT_NOFOLLOW          0x00000001
const FSOPT_NOFOLLOW = 0x00000001;
const OPTIONS = BigInt(FSOPT_ATTR_CMN_EXTENDED | FSOPT_NOFOLLOW);

// apple/darwin-xnu bsd/sys/stat.h:542  #define EF_MAY_SHARE_BLOCKS 0x00000001
// NOTE: the kernel header has NO `EF_SHARES_ALL_BLOCKS` constant — the plan's
// 0x00000002 is actually `EF_NO_XATTRS`. Repurposing it would mislabel a
// distinct flag, so only `mayShareBlocks` is exposed (Task 1 discrepancy).
const EF_MAY_SHARE_BLOCKS = 0x00000001;

type Libc = {
    getattrlist: (
        path: number,
        attrList: number,
        attrBuf: number,
        attrBufSize: bigint,
        options: bigint,
    ) => number;
};

let libc: Libc | null = null;
let libcTried = false;

function getLibc(): Libc | null {
    if (libcTried) {
        return libc;
    }

    libcTried = true;
    if (!IS_DARWIN) {
        return null;
    }

    const signature = {
        getattrlist: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
            returns: FFIType.i32,
        },
    } as const;
    for (const candidate of ["libSystem.dylib", "/usr/lib/libSystem.B.dylib"]) {
        try {
            libc = dlopen(candidate, signature).symbols as unknown as Libc;
            return libc;
        } catch {
            // try next candidate
        }
    }

    return libc;
}

function buildAttrList(forkAttr: number): ArrayBuffer {
    const al = new ArrayBuffer(24);
    const dv = new DataView(al);
    dv.setUint16(0, ATTR_BIT_MAP_COUNT, true); // bitmapcount
    dv.setUint16(2, 0, true); // reserved
    dv.setUint32(4, 0, true); // commonattr
    dv.setUint32(8, 0, true); // volattr
    dv.setUint32(12, 0, true); // dirattr
    dv.setUint32(16, 0, true); // fileattr
    dv.setUint32(20, forkAttr, true); // forkattr (CMNEXT attrs live here)
    return al;
}

// Single CMNEXT fork attribute → the requested value sits as one fixed-size
// field at byte 4 of attrBuf (byte 0..4 = u_int32 total length written).
function queryForkAttr(path: string, forkAttr: number): DataView | null {
    const lib = getLibc();
    if (!lib) {
        return null;
    }

    const al = buildAttrList(forkAttr);
    const out = new ArrayBuffer(64);
    const pathBuf = Buffer.from(`${path}\0`, "utf8");
    const rc = lib.getattrlist(ptr(pathBuf), ptr(al), ptr(out), 64n, OPTIONS);
    if (rc !== 0) {
        return null;
    }

    return new DataView(toArrayBuffer(ptr(out), 0, 64));
}

/** Bytes freed immediately if `path` is deleted (clone/snapshot-aware).
 *  apple/darwin-xnu bsd/vfs/vfs_attrlist.c maps ATTR_CMNEXT_PRIVATESIZE →
 *  va_private_size (sizeof off_t). Returns null off-darwin or on syscall error
 *  (EPERM/ENOENT/symlink). Never throws. */
export function getPrivateSize(path: string): number | null {
    const dv = queryForkAttr(path, ATTR_CMNEXT_PRIVATESIZE);
    if (!dv) {
        return null;
    }

    return Number(dv.getBigInt64(4, true));
}

/** APFS clone-family id: identical for files cloned from each other.
 *  0n means "no clone id". Null off-darwin / on error. */
export function getCloneId(path: string): bigint | null {
    const dv = queryForkAttr(path, ATTR_CMNEXT_CLONEID);
    if (!dv) {
        return null;
    }

    return dv.getBigUint64(4, true);
}

/** APFS extent-sharing flags for `path`. Null off-darwin / on error.
 *  Only `mayShareBlocks` (EF_MAY_SHARE_BLOCKS 0x1) is exposed — the kernel
 *  header (bsd/sys/stat.h) defines no `EF_SHARES_ALL_BLOCKS`. */
export function getExtFlags(path: string): { mayShareBlocks: boolean } | null {
    const dv = queryForkAttr(path, ATTR_CMNEXT_EXT_FLAGS);
    if (!dv) {
        return null;
    }

    const flags = dv.getUint32(4, true);
    return {
        mayShareBlocks: (flags & EF_MAY_SHARE_BLOCKS) !== 0,
    };
}

/** True only if running on macOS AND a probe getattrlist call succeeds. */
export function isApfsCloneSupported(): boolean {
    if (!IS_DARWIN) {
        return false;
    }

    return getPrivateSize(process.cwd()) !== null;
}
