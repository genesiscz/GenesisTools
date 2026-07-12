import { logger } from "@app/logger";

const TRAILER = Buffer.from("\n---- Bun! ----\n", "latin1");
const SIZEOF_OFFSETS = 32;
const STRIDE_NEW = 52;
const STRIDE_OLD = 36;

export interface BunModule {
    name: string;
    contents: Uint8Array;
    loader: number;
    isEntrypoint: boolean;
}

function parseModuleTable({
    buf,
    blobStart,
    byteCount,
    modulesOff,
    modulesLen,
    entryPointId,
    stride,
}: {
    buf: Buffer;
    blobStart: number;
    byteCount: number;
    modulesOff: number;
    modulesLen: number;
    entryPointId: number;
    stride: number;
}): BunModule[] {
    const count = modulesLen / stride;

    if (entryPointId >= count) {
        throw new Error(`entrypoint id ${entryPointId} out of range for ${count} modules (stride ${stride})`);
    }

    const modules: BunModule[] = [];

    for (let i = 0; i < count; i++) {
        const entry = blobStart + modulesOff + i * stride;
        const nameOff = buf.readUInt32LE(entry);
        const nameLen = buf.readUInt32LE(entry + 4);
        const contentsOff = buf.readUInt32LE(entry + 8);
        const contentsLen = buf.readUInt32LE(entry + 12);
        const loader = buf[entry + stride - 3] ?? 0;

        if (nameOff + nameLen > byteCount || contentsOff + contentsLen > byteCount) {
            throw new Error(`module ${i} offsets out of bounds`);
        }

        const name = buf.subarray(blobStart + nameOff, blobStart + nameOff + nameLen).toString("utf8");

        if (!/^[\x20-\x7e]+$/.test(name)) {
            throw new Error(`module ${i} name is not printable — wrong blob base`);
        }

        modules.push({
            name,
            contents: buf.subarray(blobStart + contentsOff, blobStart + contentsOff + contentsLen),
            loader,
            isEntrypoint: i === entryPointId,
        });
    }

    if (!modules.some((m) => m.name.includes("$bunfs") || m.name.endsWith(".js"))) {
        throw new Error("no plausible module names — likely a decoy trailer");
    }

    return modules;
}

function parseAtTrailer(buf: Buffer, trailerPos: number): BunModule[] {
    const offsetsPos = trailerPos - SIZEOF_OFFSETS;

    if (offsetsPos < 0) {
        throw new Error("offsets struct out of range");
    }

    const byteCount = Number(buf.readBigUInt64LE(offsetsPos));
    const modulesOff = buf.readUInt32LE(offsetsPos + 8);
    const modulesLen = buf.readUInt32LE(offsetsPos + 12);
    const entryPointId = buf.readUInt32LE(offsetsPos + 16);
    const blobStart = trailerPos + TRAILER.length - (byteCount + SIZEOF_OFFSETS + TRAILER.length);

    if (blobStart < 0 || modulesOff + modulesLen > byteCount) {
        throw new Error("implausible offsets — likely a decoy trailer");
    }

    // 36×13 === 52×9, so a table length can satisfy both strides: try every compatible
    // stride and accept the first that yields a plausible module list.
    const strides = [STRIDE_NEW, STRIDE_OLD].filter((s) => modulesLen % s === 0);

    if (strides.length === 0 || modulesLen === 0) {
        throw new Error(`modules table length ${modulesLen} fits no known stride`);
    }

    let lastError: unknown = null;

    for (const stride of strides) {
        try {
            return parseModuleTable({ buf, blobStart, byteCount, modulesOff, modulesLen, entryPointId, stride });
        } catch (err) {
            lastError = err;
            logger.debug({ error: err, stride, modulesLen }, "bun-binary: stride candidate rejected");
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Locates the Bun standalone module graph by scanning for the trailer from the END of the
 * binary (the Bun runtime embeds a decoy copy of the trailer constant ~50MB in; the real one
 * terminates the data section near EOF). Validates each candidate and falls back to earlier
 * occurrences. Works for Mach-O/ELF/PE without parsing container formats.
 */
export function extractBunModules(binary: Uint8Array): BunModule[] {
    const buf = Buffer.isBuffer(binary) ? binary : Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
    let candidate = buf.lastIndexOf(TRAILER);
    let lastError: unknown = null;

    while (candidate !== -1) {
        try {
            return parseAtTrailer(buf, candidate);
        } catch (err) {
            lastError = err;
            logger.debug({ error: err, candidate }, "bun-binary: trailer candidate rejected, retrying earlier");
            candidate = candidate > 0 ? buf.lastIndexOf(TRAILER, candidate - 1) : -1;
        }
    }

    throw new Error(`Bun trailer not found or all candidates invalid (last: ${lastError})`);
}
