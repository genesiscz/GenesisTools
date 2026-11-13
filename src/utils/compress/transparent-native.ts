import { dlopen, FFIType } from "bun:ffi";
import { lstatSync } from "node:fs";

export type TransparentAlgorithm = "zlib" | "lzvn" | "lzfse";
const CODES: Record<TransparentAlgorithm, number> = { zlib: 0x205, lzvn: 0x100, lzfse: 0x801 };

let compression: ReturnType<typeof loadCompression> | undefined;
function loadCompression() {
    return dlopen("/usr/lib/libcompression.dylib", {
        compression_encode_buffer: {
            args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u32],
            returns: FFIType.u64,
        },
    });
}

/** In-memory sample using exactly the chosen decmpfs codec. */
export function encodedSampleBytes(bytes: Uint8Array, algorithm: TransparentAlgorithm): number {
    compression ??= loadCompression();
    const output = Buffer.alloc(bytes.length * 2 + 1024);
    const result = Number(
        compression.symbols.compression_encode_buffer(
            output,
            output.length,
            bytes,
            bytes.length,
            null,
            CODES[algorithm]
        )
    );
    return result || bytes.length;
}

let times: ReturnType<typeof loadTimes> | undefined;
function loadTimes() {
    return dlopen("/usr/lib/libSystem.B.dylib", {
        utimensat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
}

/** afsctool truncates sub-microsecond timestamps; restore through timespec, without JS Date rounding. */
export function restoreFileTimes(source: string, target: string): void {
    const original = lstatSync(source, { bigint: true });
    const spec = Buffer.alloc(32);
    for (const [offset, value] of [
        [0, original.atimeNs],
        [16, original.mtimeNs],
    ] as const) {
        spec.writeBigInt64LE(value / 1_000_000_000n, offset);
        spec.writeBigInt64LE(value % 1_000_000_000n, offset + 8);
    }

    times ??= loadTimes();
    if (times.symbols.utimensat(-2, Buffer.from(`${target}\0`), spec, 0) !== 0) {
        throw new Error(`Could not preserve timestamps: ${target}`);
    }

    if (lstatSync(target, { bigint: true }).mtimeNs !== original.mtimeNs) {
        throw new Error(`Timestamp verification failed: ${target}`);
    }
}

let xattrs: ReturnType<typeof loadXattrs> | undefined;
function loadXattrs() {
    return dlopen("/usr/lib/libSystem.B.dylib", {
        getxattr: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
            returns: FFIType.i64,
        },
    });
}

/** Read the stored codec instead of trusting a writer's requested option. */
export function storedCompressionAlgorithm(path: string): TransparentAlgorithm | null {
    xattrs ??= loadXattrs();
    const value = Buffer.alloc(3802);
    const bytes = Number(
        xattrs.symbols.getxattr(
            Buffer.from(`${path}\0`),
            Buffer.from("com.apple.decmpfs\0"),
            value,
            value.length,
            0,
            0x21
        )
    );
    if (bytes < 16 || value.readUInt32LE(0) !== 0x636d7066) {
        return null;
    }

    const codecs: Record<number, TransparentAlgorithm> = {
        3: "zlib",
        4: "zlib",
        7: "lzvn",
        8: "lzvn",
        11: "lzfse",
        12: "lzfse",
    };
    return codecs[value.readUInt32LE(4)] ?? null;
}
