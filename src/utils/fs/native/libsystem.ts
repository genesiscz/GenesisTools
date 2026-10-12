import { FFIType, read } from "bun:ffi";
import { constants } from "node:os";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";

/**
 * The file calls of macOS `libSystem`, bound once through `bun:ffi` for every native fs utility here, or null off
 * macOS (each caller then uses `node:fs`). Pass typed arrays and Buffers to these calls as themselves, never a
 * `ptr()` kept from earlier: see `defineSystemLibrary` and `src/utils/bun/compiler/README.md`.
 */
export const libSystem = defineSystemLibrary({
    path: "/usr/lib/libSystem.B.dylib",
    platforms: ["darwin"],
    symbols: {
        open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        pread: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
        lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
        getattrlistbulk: {
            args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
            returns: FFIType.i32,
        },
        __error: { args: [], returns: FFIType.ptr },
    },
});

export type LibSystem = NonNullable<ReturnType<typeof libSystem>>;

/** `<fcntl.h>` and `<unistd.h>` values on macOS. */
export const O_RDONLY = 0;
export const O_DIRECTORY = 0x100000;
export const O_NONBLOCK = 0x4;
export const O_CLOEXEC = 0x1000000;
export const SEEK_END = 2;

/** The calling thread's `errno`, read right after the call that failed. */
export function errnoNow(calls: LibSystem): number {
    const location = calls.__error();
    return location ? read.i32(location, 0) : 0;
}

/** An error shaped like the one `node:fs` throws (`code`, `errno`, `syscall`, `path`), so callers handle both alike. */
export function errnoError(errno: number, syscall: string, path: string): NodeJS.ErrnoException {
    const code = Object.entries(constants.errno).find(([, value]) => value === errno)?.[0] ?? "EIO";
    return Object.assign(new Error(`${code}: ${syscall} failed, '${path}'`), { code, errno: -errno, syscall, path });
}

/** A C string for a path argument: UTF-8 with the closing NUL. */
export function cPath(path: string): Buffer {
    return Buffer.from(`${path}\0`);
}
