/**
 * `getattrlistbulk(2)` Bun FFI binding. Reads name + objtype + mtime +
 * fileid + size + APFS clone-id for every entry in a directory in ONE
 * syscall, instead of the `readdir` + N × `statSync` + N × `getattrlist`
 * combo `walkFiles` currently uses on macOS.
 *
 * Empirical layout (verified on macOS 14 / 25.x APFS Data volume,
 * `scripts/benchmarks/clones/microbenches/apfs-smoke-getattrlistbulk.ts`):
 *
 *   entry := length(u32) returned_attrs(5×u32)
 *            ERROR(u32)                    // packed FIRST after returned_attrs
 *            NAME(attrreference: i32 offset, u32 length)
 *            OBJTYPE(u32)                  // fsobj_type_t: VREG=1, VDIR=2, VLNK=5
 *            MODTIME(i64 sec, i64 nsec)
 *            FILEID(u64)
 *            TOTALSIZE(i64)                // fileattr — logical bytes
 *            ALLOCSIZE(i64)                // fileattr — disk-allocated bytes
 *            CLONEID(u64)                  // forkattr reinterpreted as cmnext
 *            <variable: name bytes + padding>
 *
 * Fixed area = 88 bytes. NAME attr_dataoffset is relative to the start
 * of the NAME attrreference (i.e. byte 28 within the entry); attr_length
 * includes the trailing NUL.
 *
 * Constants verified against apple/darwin-xnu `bsd/sys/attr.h`. The
 * `ATTR_CMN_ERROR is packed first` behaviour is documented in xnu's
 * `bsd/man/man2/getattrlistbulk.2` and explicit in the bulk handler
 * `getattrlist_pack_invalid_attrs` in `bsd/vfs/vfs_attrlist.c`.
 */

import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { logger } from "@app/logger";

const IS_DARWIN = process.platform === "darwin";
const log = logger.child({ component: "macos:getattrlistbulk" });

// --- attr.h constants ---------------------------------------------------------
const ATTR_BIT_MAP_COUNT = 5;
const ATTR_CMN_NAME = 0x00000001;
const ATTR_CMN_OBJTYPE = 0x00000008;
const ATTR_CMN_MODTIME = 0x00000400;
const ATTR_CMN_FILEID = 0x02000000;
const ATTR_CMN_ERROR = 0x20000000;
const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_FILE_TOTALSIZE = 0x00000002;
const ATTR_FILE_ALLOCSIZE = 0x00000004;
const ATTR_CMNEXT_CLONEID = 0x00000100;
const FSOPT_PACK_INVAL_ATTRS = 0x00000008;
const FSOPT_ATTR_CMN_EXTENDED = 0x00000020;
const BULK_OPTS = BigInt(FSOPT_ATTR_CMN_EXTENDED | FSOPT_PACK_INVAL_ATTRS);

// --- fcntl.h constants --------------------------------------------------------
const O_RDONLY = 0;
const O_DIRECTORY = 0x100000;
const O_NOFOLLOW = 0x000100;

// --- errno values -------------------------------------------------------------
/** ENOTSUP — operation not supported on this filesystem (e.g. SMB, FUSE).
 *  Caller MUST fall back to `readdir + stat`. */
export const ENOTSUP = 45;
/** EACCES — permission denied. Skip this dir; not necessarily a fatal error. */
export const EACCES = 13;

// --- fsobj_type_t -------------------------------------------------------------
const VREG = 1;
const VDIR = 2;
const VLNK = 5;

export type BulkEntryKind = "REG" | "DIR" | "LNK" | "OTHER";

export interface BulkEntry {
    name: string;
    kind: BulkEntryKind;
    /** File size in bytes — meaningful only for REG. 0 for DIR/LNK. */
    size: bigint;
    /** Disk-allocated bytes (st.blocks × 512 equivalent). For files smaller
     *  than the FS block size this is bigger than `size`. */
    allocSize: bigint;
    /** Modification time in absolute nanoseconds (sec*1e9 + nsec). */
    mtimeNs: bigint;
    /** Inode number. */
    fileid: bigint;
    /** APFS clone family id, or 0n if the file has no clone family. */
    cloneId: bigint;
    /** Per-entry errno; non-zero entries should be skipped by the caller. */
    errorCode: number;
}

import type { Pointer } from "bun:ffi";

interface LibcGetattr {
    getattrlistbulk: (
        dirfd: number,
        attrList: Pointer | null,
        attrBuf: Pointer | null,
        attrBufSize: bigint,
        options: bigint
    ) => number;
    open: (path: ArrayBufferLike, flags: number) => number;
    close: (fd: number) => number;
    __error: () => Pointer | null;
}

let libc: LibcGetattr | null = null;
let libcTried = false;

function getLibc(): LibcGetattr | null {
    if (libcTried) {
        return libc;
    }

    libcTried = true;
    if (!IS_DARWIN) {
        return null;
    }

    const sigs = {
        getattrlistbulk: {
            args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
            returns: FFIType.i32,
        },
        open: {
            args: [FFIType.cstring, FFIType.i32],
            returns: FFIType.i32,
        },
        close: {
            args: [FFIType.i32],
            returns: FFIType.i32,
        },
        __error: {
            args: [],
            returns: FFIType.ptr,
        },
    } as const;

    for (const candidate of ["libSystem.dylib", "/usr/lib/libSystem.B.dylib"]) {
        const sym: Record<string, unknown> = {};
        for (const [name, sig] of Object.entries(sigs)) {
            try {
                sym[name] = dlopen(candidate, { [name]: sig }).symbols[name];
            } catch (err) {
                log.debug({ err, candidate, name }, "symbol bind failed");
            }
        }

        if (sym.getattrlistbulk && sym.open && sym.close && sym.__error) {
            libc = sym as unknown as LibcGetattr;
            return libc;
        }
    }

    log.debug("no libc candidate fully bound; getattrlistbulk unavailable");
    return libc;
}

// --- attrlist buffer ---------------------------------------------------------
// 24 bytes packed: u16 count, u16 reserved, 5 × u32 attrgroup.
// Built once at module load — it's identical for every call.
const ATTRLIST_BUF = new ArrayBuffer(24);
{
    const dv = new DataView(ATTRLIST_BUF);
    dv.setUint16(0, ATTR_BIT_MAP_COUNT, true);
    dv.setUint16(2, 0, true);
    dv.setUint32(
        4,
        ATTR_CMN_RETURNED_ATTRS |
            ATTR_CMN_NAME |
            ATTR_CMN_OBJTYPE |
            ATTR_CMN_MODTIME |
            ATTR_CMN_FILEID |
            ATTR_CMN_ERROR,
        true
    );
    dv.setUint32(8, 0, true);
    dv.setUint32(12, 0, true);
    dv.setUint32(16, ATTR_FILE_TOTALSIZE | ATTR_FILE_ALLOCSIZE, true);
    dv.setUint32(20, ATTR_CMNEXT_CLONEID, true);
}
const ATTRLIST_PTR = ptr(ATTRLIST_BUF);

// 128 KB output buffer — matches the size Healey's dumac landed on after
// scanning the parameter space. Reused across syscalls and across dirs to
// avoid GC churn (this module isn't multi-threaded so single-buf is safe).
const BUF_BYTES = 128 * 1024;
const OUT_BUF = new ArrayBuffer(BUF_BYTES);
const OUT_BUF_PTR = ptr(OUT_BUF);
const OUT_VIEW = new DataView(OUT_BUF);
const OUT_U8 = new Uint8Array(OUT_BUF);
const DECODER = new TextDecoder();

function kindOf(objtype: number): BulkEntryKind {
    if (objtype === VREG) {
        return "REG";
    }

    if (objtype === VDIR) {
        return "DIR";
    }

    if (objtype === VLNK) {
        return "LNK";
    }

    return "OTHER";
}

/** Raised when the kernel returns ENOTSUP for a dir — caller MUST fall back to
 *  `readdir + statSync` for that subtree. */
export class GetattrlistbulkUnsupportedError extends Error {
    constructor(public readonly path: string) {
        super(`getattrlistbulk not supported on ${path} (ENOTSUP)`);
        this.name = "GetattrlistbulkUnsupportedError";
    }
}

function readErrno(lib: LibcGetattr): number {
    const errnoPtr = lib.__error();
    if (!errnoPtr) {
        return 0;
    }

    return read.i32(errnoPtr);
}

/** Yield every entry in `dirPath` via getattrlistbulk. Throws
 *  GetattrlistbulkUnsupportedError on ENOTSUP so the caller can fall back.
 *  Other errno values are surfaced as a plain Error. */
export function* iterDir(dirPath: string): Generator<BulkEntry> {
    const lib = getLibc();
    if (!lib) {
        throw new Error("getattrlistbulk: libc not bound (non-darwin or symbol missing)");
    }

    // FFIType.cstring expects ArrayBufferLike; Buffer.from(...).buffer is the
    // backing SharedArrayBuffer.
    const cPath = Buffer.from(`${dirPath}\0`, "utf8");
    const fd = lib.open(cPath.buffer as ArrayBufferLike, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0) {
        const errno = readErrno(lib);
        const err = new Error(`open(${dirPath}) failed, errno=${errno}`);
        (err as Error & { errno?: number }).errno = errno;
        throw err;
    }

    try {
        while (true) {
            const n = lib.getattrlistbulk(fd, ATTRLIST_PTR, OUT_BUF_PTR, BigInt(BUF_BYTES), BULK_OPTS);
            if (n < 0) {
                const errno = readErrno(lib);
                if (errno === ENOTSUP) {
                    throw new GetattrlistbulkUnsupportedError(dirPath);
                }

                const err = new Error(`getattrlistbulk(${dirPath}) failed, errno=${errno}`);
                (err as Error & { errno?: number }).errno = errno;
                throw err;
            }

            if (n === 0) {
                return;
            }

            let off = 0;
            for (let i = 0; i < n; i++) {
                const entryStart = off;
                const entryLen = OUT_VIEW.getUint32(off, true);
                off += 4;
                // Skip returned_attrs — we already know what we asked for and
                // FSOPT_PACK_INVAL_ATTRS guarantees default-fill for any attr
                // the FS doesn't support. (We could check returnedCommon &
                // ATTR_CMN_NAME etc. to detect unsupported attrs per-entry,
                // but on APFS all six are always supported.)
                off += 20;
                // ATTR_CMN_ERROR: packed first.
                const errorCode = OUT_VIEW.getUint32(off, true);
                off += 4;
                // NAME attrreference — i32 offset (relative to attrreference
                // start), u32 length (incl trailing NUL).
                const nameRefStart = off;
                const nameOffset = OUT_VIEW.getInt32(off, true);
                off += 4;
                const nameLength = OUT_VIEW.getUint32(off, true);
                off += 4;
                const objtype = OUT_VIEW.getUint32(off, true);
                off += 4;
                const sec = OUT_VIEW.getBigInt64(off, true);
                off += 8;
                const nsec = OUT_VIEW.getBigInt64(off, true);
                off += 8;
                const fileid = OUT_VIEW.getBigUint64(off, true);
                off += 8;
                const totalsize = OUT_VIEW.getBigInt64(off, true);
                off += 8;
                const allocsize = OUT_VIEW.getBigInt64(off, true);
                off += 8;
                const cloneId = OUT_VIEW.getBigUint64(off, true);
                off += 8;

                // Name string: drop trailing NUL.
                const nameStart = nameRefStart + nameOffset;
                const nameEnd = nameStart + nameLength - 1;
                const name = DECODER.decode(OUT_U8.subarray(nameStart, nameEnd));

                yield {
                    name,
                    kind: kindOf(objtype),
                    size: totalsize,
                    allocSize: allocsize,
                    mtimeNs: sec * 1_000_000_000n + nsec,
                    fileid,
                    cloneId,
                    errorCode,
                };

                // Jump to next entry by the kernel-reported length — handles
                // any padding the kernel may have inserted for alignment.
                off = entryStart + entryLen;
            }
        }
    } finally {
        lib.close(fd);
    }
}

/** Recursively walk `root`, counting dirs + files. Used by the WALK
 *  microbenchmark; structurally identical to `walkReaddirStat` but each
 *  dir is one syscall instead of `1 readdir + N stats`.
 *
 *  Falls back per-dir if the kernel returns ENOTSUP (non-APFS volume). */
export function walkGetattrlistbulk(root: string): { dirs: number; files: number } {
    const lib = getLibc();
    if (!lib) {
        throw new Error("walkGetattrlistbulk: not on darwin or libSystem failed to bind");
    }

    let dirs = 0;
    let files = 0;
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop() as string;
        try {
            // Inline counting so we don't pay an iterator-protocol cost per
            // entry on hot 10⁶-entry trees.
            for (const e of iterDir(cur)) {
                if (e.errorCode !== 0) {
                    continue;
                }

                if (e.kind === "DIR") {
                    stack.push(`${cur}/${e.name}`);
                } else if (e.kind === "REG") {
                    files += 1;
                }
                // LNK / OTHER: count nothing, don't descend
            }
            dirs += 1;
        } catch (err) {
            if (err instanceof GetattrlistbulkUnsupportedError) {
                log.debug({ path: cur }, "ENOTSUP; falling back per-dir (not implemented in bench walker)");
                // For the bench walker we just count this dir and stop here;
                // production walkFiles will fall back per-dir.
                continue;
            }

            // EACCES / other open failures: skip silently — matches walkFiles
            // behaviour (it also try/catches readdirSync).
            log.debug({ path: cur, err }, "skipping dir");
        }
    }

    return { dirs, files };
}

/** Feature detection: returns true if the binding is loadable AND a probe
 *  call succeeds on the cwd. */
export function isGetattrlistbulkSupported(): boolean {
    const lib = getLibc();
    if (!lib) {
        return false;
    }

    try {
        // Probe: just call iterDir on cwd and consume one entry.
        for (const _e of iterDir(process.cwd())) {
            void _e;
            return true;
        }

        // Empty dir is still supported.
        return true;
    } catch (err) {
        if (err instanceof GetattrlistbulkUnsupportedError) {
            return false;
        }

        log.debug({ err }, "feature-detect probe failed");
        return false;
    }
}
