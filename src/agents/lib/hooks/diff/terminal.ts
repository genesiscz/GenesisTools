import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import { openSync } from "node:fs";
import { WriteStream } from "node:tty";
import { hookDiag } from "../log";

/**
 * `struct kinfo_proc` on darwin, from `sys/sysctl.h` and `sys/proc.h`; the same offsets
 * `src/utils/process/libproc-table.ts` checked with `offsetof`. That module is not imported here:
 * it loads the logger, which costs 28 to 59 ms on the hook's path (measured 2026-10-14), while
 * this lookup costs 1.7 ms.
 */
const KINFO_PROC_SIZE = 648;
const KP_PPID = 560;
const KP_TDEV = 572;
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
const S_IFCHR = 0o020000;
const NODEV = -1;
const MAX_HOPS = 8;

function libSystem() {
    return dlopen("/usr/lib/libSystem.B.dylib", {
        sysctl: {
            args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
            returns: FFIType.i32,
        },
        devname: { args: [FFIType.i32, FFIType.u16], returns: FFIType.ptr },
    });
}

/** The terminal of the nearest ancestor that has one (`ttys010`), walking up from this process's parent. */
function ancestorTerminal(): string | null {
    const lib = libSystem();

    try {
        const row = new Uint8Array(KINFO_PROC_SIZE);
        const view = new DataView(row.buffer);
        const size = new BigUint64Array(1);
        let pid = process.ppid;

        for (let hop = 0; hop < MAX_HOPS && pid > 1; hop += 1) {
            const mib = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]);
            size[0] = BigInt(KINFO_PROC_SIZE);

            if (lib.symbols.sysctl(ptr(mib), 4, ptr(row), ptr(size), null, 0) !== 0) {
                return null;
            }

            const device = view.getInt32(KP_TDEV, true);

            if (device !== NODEV && device !== 0) {
                const name = lib.symbols.devname(device, S_IFCHR);

                if (name) {
                    return new CString(name).toString();
                }
            }

            pid = view.getInt32(KP_PPID, true);
        }

        return null;
    } finally {
        lib.close();
    }
}

/**
 * The width of the terminal the harness draws in, or `null` when it cannot be known.
 *
 * A hook has no terminal of its own: Claude Code starts it without one (`/dev/tty` is ENXIO and
 * `COLUMNS` is 0, observed 2026-10-14). The harness process itself still has one, so the width is
 * read from the first ancestor with a controlling terminal. darwin only; elsewhere the bands are
 * not padded, which only makes them end at the text.
 */
export function terminalColumns(): number | null {
    if (process.platform !== "darwin") {
        return null;
    }

    try {
        const name = ancestorTerminal();

        if (!name) {
            return null;
        }

        // The stream reads the size with the right ioctl; `ioctl` is variadic, which an FFI call
        // cannot pass correctly on arm64. Destroying the stream closes only the descriptor opened here.
        const stream = new WriteStream(openSync(`/dev/${name}`, "r"));
        const columns = stream.columns;

        stream.destroy();
        return Number.isInteger(columns) && columns > 0 ? columns : null;
    } catch (err) {
        hookDiag("Could not read the terminal width", { err });
        return null;
    }
}
