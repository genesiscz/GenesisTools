import { logger } from "@genesiscz/utils/logger";

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

interface LocatedModule extends BunModule {
    tableOffset: number;
    stride: number;
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
}): LocatedModule[] {
    const count = modulesLen / stride;

    if (entryPointId >= count) {
        throw new Error(`entrypoint id ${entryPointId} out of range for ${count} modules (stride ${stride})`);
    }

    const modules: LocatedModule[] = [];

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
            tableOffset: entry,
            stride,
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

function parseAtTrailer(buf: Buffer, trailerPos: number): LocatedModule[] {
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
function locateBunModules(binary: Uint8Array): LocatedModule[] {
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

export function extractBunModules(binary: Uint8Array): BunModule[] {
    return locateBunModules(binary).map(({ name, contents, loader, isEntrypoint }) => ({
        name,
        contents,
        loader,
        isEntrypoint,
    }));
}

export function replaceBunModule(binary: Buffer, name: string, source: Uint8Array): void {
    const matches = locateBunModules(binary).filter((module) => module.name === name);
    const [module] = matches;

    if (!module || matches.length !== 1 || module.stride !== STRIDE_NEW || module.loader !== 1) {
        throw new Error(`Expected one JavaScript module in a 52-byte Bun module table: ${name}`);
    }

    if (source.length !== module.contents.length) {
        throw new Error("Replacement must preserve the original module byte length");
    }

    module.contents.set(source);
    // CompiledModuleGraphFile stores bytecode as its fourth offset/length pair.
    // Clear the pointer so Bun evaluates the updated JavaScript.
    binary.fill(0, module.tableOffset + 24, module.tableOffset + 32);
}
