import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, rmSync, statSync, writeSync } from "node:fs";

import { SafeJSON } from "@genesiscz/utils/json";

const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

export interface AsarIntegrity {
    algorithm: "SHA256";
    hash: string;
    blockSize: number;
    blocks: string[];
}

interface AsarDir {
    kind: "dir";
    raw: Record<string, unknown>;
    files: Map<string, AsarNode>;
}

interface AsarFile {
    kind: "file";
    raw: Record<string, unknown>;
    size: number;
    offset: number | undefined;
    unpacked: boolean;
    data?: Buffer;
}

type AsarNode = AsarDir | AsarFile;

export interface AsarArchive {
    sourcePath: string;
    dataStart: number;
    headerHash: string;
    rootRaw: Record<string, unknown>;
    root: AsarDir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOffset(value: unknown, path: string): number {
    const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${path} has a bad asar offset`);
    }

    return parsed;
}

function parseNode(value: unknown, path: string): AsarNode {
    if (!isRecord(value)) {
        throw new Error(`${path} is not an asar object`);
    }

    if (isRecord(value.files)) {
        const files = new Map<string, AsarNode>();
        for (const [name, child] of Object.entries(value.files)) {
            files.set(name, parseNode(child, `${path}/${name}`));
        }

        return { kind: "dir", raw: value, files };
    }

    if (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0) {
        throw new Error(`${path} has no asar size`);
    }

    const unpacked = value.unpacked === true;

    return {
        kind: "file",
        raw: value,
        size: value.size,
        offset: unpacked ? undefined : readOffset(value.offset, path),
        unpacked,
    };
}

function parseHeader(value: unknown): { rootRaw: Record<string, unknown>; root: AsarDir } {
    if (!isRecord(value) || !isRecord(value.files)) {
        throw new Error("asar header has no files object");
    }

    const root = parseNode(value, "asar");
    if (root.kind !== "dir") {
        throw new Error("asar root is not a directory");
    }

    return { rootRaw: value, root };
}

/** SHA256 of one packed file, in the block form Electron stores on each asar entry. */
export function fileIntegrity(content: Buffer): AsarIntegrity {
    const blocks: string[] = [];
    const whole = createHash("sha256");
    const step = content.length === 0 ? 1 : INTEGRITY_BLOCK_SIZE;
    for (let offset = 0; offset < content.length || blocks.length === 0; offset += step) {
        const slice = content.subarray(offset, Math.min(offset + INTEGRITY_BLOCK_SIZE, content.length));
        blocks.push(createHash("sha256").update(slice).digest("hex"));
        whole.update(slice);
        if (content.length === 0) {
            break;
        }
    }

    return {
        algorithm: "SHA256",
        hash: whole.digest("hex"),
        blockSize: INTEGRITY_BLOCK_SIZE,
        blocks,
    };
}

function encodePickle(payload: Buffer): Buffer {
    if (payload.length % 4 !== 0) {
        throw new Error("asar pickle payload must be 4-byte aligned");
    }

    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);

    return Buffer.concat([header, payload]);
}

function encodeHeader(json: string): Buffer {
    const text = Buffer.from(json);
    const pad = (4 - (text.length % 4)) % 4;
    const length = Buffer.alloc(4);
    length.writeUInt32LE(text.length, 0);
    const payload = Buffer.concat([length, text, Buffer.alloc(pad)]);
    const headerPickle = encodePickle(payload);
    const sizePayload = Buffer.alloc(4);
    sizePayload.writeUInt32LE(headerPickle.length, 0);

    return Buffer.concat([encodePickle(sizePayload), headerPickle]);
}

function decodeHeader(fd: number): { json: string; dataStart: number } {
    const sizeBuf = Buffer.alloc(8);
    if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) {
        throw new Error("asar header size is unreadable");
    }

    if (sizeBuf.readUInt32LE(0) !== 4) {
        throw new Error("asar header size pickle is not a single uint32");
    }

    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerPickleSize);
    if (readSync(fd, headerBuf, 0, headerPickleSize, 8) !== headerPickleSize) {
        throw new Error("asar header pickle is short");
    }

    const stringLength = headerBuf.readUInt32LE(4);
    const json = headerBuf.subarray(8, 8 + stringLength).toString("utf8");

    return { json, dataStart: 8 + headerPickleSize };
}

export function openAsar(sourcePath: string): AsarArchive {
    const fd = openSync(sourcePath, "r");
    try {
        const decoded = decodeHeader(fd);
        const parsed = SafeJSON.parse(decoded.json);
        const header = parseHeader(parsed);

        return {
            sourcePath,
            dataStart: decoded.dataStart,
            headerHash: createHash("sha256").update(decoded.json).digest("hex"),
            rootRaw: header.rootRaw,
            root: header.root,
        };
    } finally {
        closeSync(fd);
    }
}

export function asarParts(filePath: string): string[] {
    const parts = filePath.split("/");
    if (
        filePath.startsWith("/") ||
        filePath.includes("\\") ||
        parts.some((part) => part === "" || part === "." || part === "..")
    ) {
        throw new Error(`Unsafe asar path ${filePath}`);
    }

    return parts;
}

function lookup(root: AsarDir, filePath: string): AsarFile | undefined {
    const parts = asarParts(filePath);
    let dir = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const next = dir.files.get(parts[index] ?? "");
        if (next?.kind === "dir") {
            dir = next;
            continue;
        }

        return undefined;
    }

    const found = dir.files.get(parts[parts.length - 1] ?? "");
    if (found?.kind === "file") {
        return found;
    }

    return undefined;
}

export function readAsarFile(archive: AsarArchive, filePath: string): Buffer {
    const file = lookup(archive.root, filePath);
    if (!file) {
        throw new Error(`${filePath} is not in the asar`);
    }

    if (file.data) {
        return file.data;
    }

    if (file.unpacked || file.offset === undefined) {
        throw new Error(`${filePath} is unpacked`);
    }

    const buf = Buffer.alloc(file.size);
    const fd = openSync(archive.sourcePath, "r");
    try {
        const got = readSync(fd, buf, 0, file.size, archive.dataStart + file.offset);
        if (got !== file.size) {
            throw new Error(`${filePath} was shorter than its asar header`);
        }
    } finally {
        closeSync(fd);
    }

    return buf;
}

function ensureDir(dir: AsarDir, name: string, path: string): AsarDir {
    const existing = dir.files.get(name);
    if (!existing) {
        const created: AsarDir = { kind: "dir", raw: {}, files: new Map() };
        dir.files.set(name, created);

        return created;
    }

    if (existing.kind !== "dir") {
        throw new Error(`${path} is a file`);
    }

    return existing;
}

export function writeAsarFile(archive: AsarArchive, filePath: string, content: Buffer | string): void {
    const parts = asarParts(filePath);
    let dir = archive.root;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const name = parts[index] ?? "";
        dir = ensureDir(dir, name, parts.slice(0, index + 1).join("/"));
    }

    const name = parts[parts.length - 1] ?? "";
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const existing = dir.files.get(name);
    if (existing?.kind === "dir") {
        throw new Error(`${filePath} is a directory`);
    }

    if (existing?.kind === "file" && existing.unpacked) {
        throw new Error(`${filePath} is unpacked; refusing to rewrite it inside the asar`);
    }

    const file: AsarFile = {
        kind: "file",
        raw: existing?.kind === "file" ? existing.raw : {},
        size: data.length,
        offset: existing?.kind === "file" ? existing.offset : undefined,
        unpacked: false,
        data,
    };
    dir.files.set(name, file);
}

function packedFiles(dir: AsarDir, prefix: string, out: { path: string; file: AsarFile }[]): void {
    for (const [name, node] of dir.files) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (node.kind === "dir") {
            packedFiles(node, path, out);
            continue;
        }

        if (!node.unpacked) {
            out.push({ path, file: node });
        }
    }
}

function serializeDir(dir: AsarDir, offsets: Map<AsarFile, number>): Record<string, unknown> {
    const files: Record<string, unknown> = {};
    for (const [name, node] of dir.files) {
        if (node.kind === "dir") {
            files[name] = { ...node.raw, files: serializeDir(node, offsets) };
            continue;
        }

        if (node.unpacked) {
            files[name] = { ...node.raw };
            continue;
        }

        const offset = offsets.get(node);
        if (offset === undefined) {
            throw new Error(`missing offset for ${name}`);
        }

        const size = node.data?.length ?? node.size;
        const next: Record<string, unknown> = { ...node.raw, size, offset: String(offset) };
        if (node.data) {
            next.integrity = fileIntegrity(node.data);
        }

        files[name] = next;
    }

    return files;
}

function copyRange(srcFd: number, destFd: number, position: number, size: number): void {
    const buf = Buffer.alloc(Math.min(size, 1024 * 1024));
    let remaining = size;
    let pos = position;
    while (remaining > 0) {
        const asked = Math.min(buf.length, remaining);
        const got = readSync(srcFd, buf, 0, asked, pos);
        if (got !== asked) {
            throw new Error("short read while rewriting asar");
        }

        writeSync(destFd, buf, 0, got);
        remaining -= got;
        pos += got;
    }
}

/**
 * Write a new archive. Unchanged packed bytes are streamed from `source`.
 * The returned hash is SHA256 of the header JSON, which is the value Electron
 * stores in Info.plist under ElectronAsarIntegrity.
 */
export function rewriteAsar(archive: AsarArchive, dest: string): { headerHash: string } {
    const files: { path: string; file: AsarFile }[] = [];
    packedFiles(archive.root, "", files);
    files.sort((left, right) => {
        const leftOffset = left.file.offset;
        const rightOffset = right.file.offset;
        if (leftOffset === undefined && rightOffset === undefined) {
            return left.path < right.path ? -1 : 1;
        }

        if (leftOffset === undefined) {
            return 1;
        }

        if (rightOffset === undefined) {
            return -1;
        }

        return leftOffset - rightOffset;
    });

    const offsets = new Map<AsarFile, number>();
    let cursor = 0;
    for (const entry of files) {
        offsets.set(entry.file, cursor);
        cursor += entry.file.data?.length ?? entry.file.size;
    }

    const header = { ...archive.rootRaw, files: serializeDir(archive.root, offsets) };
    const json = SafeJSON.stringify(header);
    const pickled = encodeHeader(json);
    const srcFd = openSync(archive.sourcePath, "r");
    let destFd: number;
    try {
        destFd = openSync(dest, "w");
    } catch (err) {
        closeSync(srcFd);
        throw err;
    }

    try {
        writeSync(destFd, pickled);
        for (const entry of files) {
            if (entry.file.data) {
                writeSync(destFd, entry.file.data);
                continue;
            }

            if (entry.file.offset === undefined) {
                throw new Error(`${entry.path} has no source offset`);
            }

            copyRange(srcFd, destFd, archive.dataStart + entry.file.offset, entry.file.size);
        }
    } finally {
        closeSync(srcFd);
        closeSync(destFd);
    }

    return { headerHash: createHash("sha256").update(json).digest("hex") };
}

/** Build an archive whose every file is new content. Used by tests and by callers that have no seed bundle. */
export function packAsar(dest: string, files: Record<string, string | Buffer>): { headerHash: string } {
    const seed = `${dest}.seed`;
    const seedFd = openSync(seed, "w");
    try {
        writeSync(seedFd, encodeHeader(SafeJSON.stringify({ files: {} })));
    } finally {
        closeSync(seedFd);
    }

    try {
        const archive = openAsar(seed);
        for (const [path, content] of Object.entries(files)) {
            writeAsarFile(archive, path, content);
        }

        return rewriteAsar(archive, dest);
    } finally {
        rmSync(seed, { force: true });
    }
}

/** ASCII needles anywhere in the archive, including across read boundaries. */
export function missingAsarNeedles(filePath: string, needles: readonly string[], chunkSize = 1024 * 1024): string[] {
    const missing = new Set(needles);
    const longest = needles.reduce((max, needle) => Math.max(max, needle.length), 0);
    const fd = openSync(filePath, "r");
    const chunk = Buffer.alloc(chunkSize);
    let carry = Buffer.alloc(0);
    try {
        const size = statSync(filePath).size;
        let pos = 0;
        while (pos < size && missing.size > 0) {
            const got = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
            if (got <= 0) {
                break;
            }

            const hay = Buffer.concat([carry, chunk.subarray(0, got)]);
            const text = hay.toString("latin1");
            for (const needle of missing) {
                if (text.includes(needle)) {
                    missing.delete(needle);
                }
            }

            carry = hay.subarray(Math.max(0, hay.length - Math.max(0, longest - 1)));
            pos += got;
        }
    } finally {
        closeSync(fd);
    }

    return [...missing];
}
