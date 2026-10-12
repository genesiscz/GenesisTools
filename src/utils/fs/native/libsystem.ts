import { FFIType, read } from "bun:ffi";
import { constants } from "node:os";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";

/**
 * The calls of macOS `libSystem`, bound once through `bun:ffi` for every native utility (the fs readers here, host
 * statistics in `src/utils/macos/host-stats.ts`), or null off macOS (each caller then has its own fallback). Pass
 * typed arrays and Buffers to these calls as themselves, never a `ptr()` kept from earlier: see
 * `defineSystemLibrary` and `src/utils/bun/compiler/README.md`.
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
        /** `mach_port_t mach_host_self(void)`: a send right to the host port (call it once, it adds a reference). */
        mach_host_self: { args: [], returns: FFIType.u32 },
        /** `kern_return_t host_statistics(host_t, host_flavor_t, host_info_t, mach_msg_type_number_t *)`. */
        host_statistics: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        /** `kern_return_t host_statistics64(host_t, host_flavor_t, host_info64_t, mach_msg_type_number_t *)`. */
        host_statistics64: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        /** `int sysctlbyname(const char *, void *oldp, size_t *oldlenp, void *newp, size_t newlen)`. */
        sysctlbyname: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
            returns: FFIType.i32,
        },
        /** `int sysctl(int *name, u_int namelen, void *oldp, size_t *oldlenp, void *newp, size_t newlen)`. */
        sysctl: {
            args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
            returns: FFIType.i32,
        },
        /** `int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)` (libproc). */
        proc_pidinfo: {
            args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
            returns: FFIType.i32,
        },
        /** `int proc_pidpath(int pid, void *buffer, uint32_t buffersize)` (libproc). */
        proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        /** `kern_return_t mach_timebase_info(mach_timebase_info_t)`: numer and denom of mach time units. */
        mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
        /** `char *devname(dev_t, mode_t)`: the `/dev` name of a device number, from a static buffer. */
        devname: { args: [FFIType.i32, FFIType.u16], returns: FFIType.ptr },
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
