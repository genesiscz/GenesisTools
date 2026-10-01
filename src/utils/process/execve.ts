import { dlopen, FFIType, ptr } from "bun:ffi";

type LibC = {
    execve: (path: unknown, argv: unknown, envp: unknown) => number;
    signal: (signal: number, handler: unknown) => unknown;
};

/** SIGKILL (9) and SIGSTOP (17 on macOS) cannot be changed; every other classic signal goes back to SIG_DFL. */
const RESETTABLE_SIGNALS = Array.from({ length: 31 }, (_, index) => index + 1).filter(
    (signal) => signal !== 9 && signal !== 17
);

function libcPath(): string | null {
    if (process.platform === "darwin") {
        return "libSystem.B.dylib";
    }

    if (process.platform === "linux") {
        return "libc.so.6";
    }

    return null;
}

function cString(value: string): Buffer {
    return Buffer.from(`${value}\0`, "utf8");
}

/** A NULL-terminated `char *[]`; `keep` holds the strings alive until the call. */
function cStringArray(values: string[], keep: Buffer[]): BigUint64Array {
    const array = new BigUint64Array(values.length + 1);

    values.forEach((value, index) => {
        const buffer = cString(value);
        keep.push(buffer);
        array[index] = BigInt(ptr(buffer));
    });

    return array;
}

/**
 * Replace this process with `file` (same pid, same open stdio). Returns only when that failed,
 * with a reason; on success nothing after the call runs. The caller flushes its own output first.
 */
export function execve(file: string, argv: string[], environment: Record<string, string | undefined>): string {
    const path = libcPath();

    if (!path) {
        return `no execve on ${process.platform}`;
    }

    let libc: LibC;

    try {
        libc = dlopen(path, {
            execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
            signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
        }).symbols as LibC;
    } catch (error) {
        return `cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`;
    }

    const keep: Buffer[] = [];
    const fileBuffer = cString(file);
    const argvArray = cStringArray(argv, keep);
    const envArray = cStringArray(
        Object.entries(environment)
            .filter((entry): entry is [string, string] => entry[1] !== undefined)
            .map(([key, value]) => `${key}=${value}`),
        keep
    );

    // An ignored signal survives exec, and bun ignores SIGPIPE and SIGXFSZ: `tools x | head` would
    // then get EPIPE instead of dying quietly. A spawned child starts from SIG_DFL, so the exec does too.
    const previous = RESETTABLE_SIGNALS.map((signal) => [signal, libc.signal(signal, null)] as const);

    const rc = libc.execve(fileBuffer, argvArray, envArray);

    // execve came back: this process carries on (the caller spawns a child instead), so it gets its
    // own dispositions back, or a later SIGPIPE would kill it.
    for (const [signal, handler] of previous) {
        libc.signal(signal, handler);
    }

    return `execve returned ${rc}`;
}
