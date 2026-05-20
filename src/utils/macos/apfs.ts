import { dlopen, FFIType, ptr } from "bun:ffi";
import logger from "@app/logger";

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

// apple/darwin-xnu bsd/sys/clonefile.h:32  #define CLONE_NOFOLLOW 0x0001
const CLONE_NOFOLLOW = 0x0001;

// apple/darwin-xnu bsd/sys/mount.h: struct statfs (64-bit-inode layout).
// Field offsets computed from bsd/man/man2/statfs.2 (natural alignment):
// f_bsize@0 f_iosize@4 f_blocks@8 f_bfree@16 f_bavail@24 f_files@32
// f_ffree@40 f_fsid@48 f_owner@56 f_type@60 f_flags@64 f_fssubtype@68
// f_fstypename@72 [char[16]]. mount.h:92 #define MFSTYPENAMELEN 16.
const STATFS_BUF_SIZE = 2304; // > sizeof(struct statfs) (~2168), padded
const F_FSTYPENAME_OFFSET = 72;
const MFSTYPENAMELEN = 16;

export class CloneUnsupportedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CloneUnsupportedError";
    }
}

type LibcExt = {
    getattrlist: (path: number, attrList: number, attrBuf: number, attrBufSize: bigint, options: bigint) => number;
    clonefile: (src: number, dst: number, flags: number) => number;
    statfs: (path: number, buf: number) => number;
};

let libc: LibcExt | null = null;
let libcTried = false;

function getLibc(): LibcExt | null {
    if (libcTried) {
        return libc;
    }

    libcTried = true;
    if (!IS_DARWIN) {
        return null;
    }

    // Bun's dlopen resolves symbols via dlsym; `statfs$INODE64` is a
    // compile-time linker alias that dlsym cannot find, so it is bound with a
    // fall back to plain `statfs` (the plain symbol IS the 64-bit-inode layout
    // on modern macOS — f_fstypename @ offset 72, verified). Per-symbol
    // dlopen so one missing symbol doesn't void the whole binding.
    const sigs = {
        getattrlist: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
            returns: FFIType.i32,
        },
        clonefile: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.i32],
            returns: FFIType.i32,
        },
    } as const;
    const statfsSig = {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
    } as const;
    for (const candidate of ["libSystem.dylib", "/usr/lib/libSystem.B.dylib"]) {
        const sym: Record<string, unknown> = {};
        for (const [name, sig] of Object.entries(sigs)) {
            try {
                sym[name] = dlopen(candidate, { [name]: sig }).symbols[name];
            } catch (err) {
                logger.debug({ err, candidate, name }, "apfs: symbol bind failed");
            }
        }

        for (const sName of ["statfs$INODE64", "statfs"]) {
            try {
                sym.statfs = dlopen(candidate, { [sName]: statfsSig }).symbols[sName];
                break;
            } catch (err) {
                logger.debug({ err, candidate, sName }, "apfs: statfs bind failed");
            }
        }

        if (sym.getattrlist && sym.clonefile && sym.statfs) {
            libc = sym as unknown as LibcExt;
            return libc;
        }
    }

    logger.debug("apfs: no libc candidate fully bound; clone APIs unavailable");
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

    // `out` is already the ArrayBuffer we allocated above — `toArrayBuffer`
    // would just round-trip its pointer back to itself. Avoid the extra FFI
    // call and wrap the buffer directly.
    return new DataView(out);
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

/** Lowercased filesystem type for the volume containing `path`
 *  (e.g. "apfs", "hfs", "exfat"). null off-darwin / on error. */
export function getFsType(path: string): string | null {
    const lib = getLibc();
    if (!lib) {
        return null;
    }

    const buf = new ArrayBuffer(STATFS_BUF_SIZE);
    const rc = lib.statfs(ptr(Buffer.from(`${path}\0`, "utf8")), ptr(buf));
    if (rc !== 0) {
        return null;
    }

    const bytes = new Uint8Array(buf, F_FSTYPENAME_OFFSET, MFSTYPENAMELEN);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(bytes.subarray(0, end === -1 ? MFSTYPENAMELEN : end)).toLowerCase();
}

/** True if the filesystem at `path` supports APFS clonefile. */
export function supportsClone(path: string): boolean {
    return getFsType(path) === "apfs";
}

/** clonefile(2): create `dst` (must NOT exist) as a COW clone of `src`.
 *  Throws CloneUnsupportedError off-darwin or on syscall failure
 *  (EXDEV cross-volume, ENOTSUP non-APFS, EEXIST dst exists). */
export function cloneFile(src: string, dst: string): void {
    const lib = getLibc();
    if (!lib) {
        throw new CloneUnsupportedError("clonefile unavailable (not macOS)");
    }

    const rc = lib.clonefile(
        ptr(Buffer.from(`${src}\0`, "utf8")),
        ptr(Buffer.from(`${dst}\0`, "utf8")),
        CLONE_NOFOLLOW
    );
    if (rc !== 0) {
        throw new CloneUnsupportedError(
            `clonefile("${src}" -> "${dst}") failed (rc=${rc}); ` +
                "volume likely not APFS or src/dst on different volumes"
        );
    }
}
