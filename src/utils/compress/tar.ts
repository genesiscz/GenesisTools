import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { env } from "@genesiscz/utils/env";
import { sha256File } from "@genesiscz/utils/fs/hash";
import { atomicWriteFileStreamed } from "@genesiscz/utils/storage/atomic-file";
import { readExistingAncestorSync } from "./file";
import { readZstdFramesSync, SeekableZstdWriter, type ZstdParams } from "./zstd";

/** The suffix of a folder packed by {@link packDirectory}: `video_files` becomes `video_files.zst` (tar inside zstd). */
export const FOLDER_ARCHIVE_SUFFIX = ".zst";
/** Accepted as a folder archive too, for archives made by `tar --zstd` or other tools. */
export const TAR_ZST_SUFFIX = ".tar.zst";

/** The folder name an archive restores to: `x.zst` and `x.tar.zst` both restore `x`. */
export function archiveBaseName(archiveName: string): string {
    if (archiveName.endsWith(TAR_ZST_SUFFIX)) {
        return archiveName.slice(0, -TAR_ZST_SUFFIX.length);
    }

    return archiveName.endsWith(FOLDER_ARCHIVE_SUFFIX)
        ? archiveName.slice(0, -FOLDER_ARCHIVE_SUFFIX.length)
        : archiveName;
}

/** True when a zstd file holds a tar stream (a packed folder), from the `ustar` magic in its first frame. */
export function isTarArchive(archive: string): boolean {
    for (const frame of readZstdFramesSync(archive)) {
        return (
            frame.length >= 262 && Buffer.from(frame.buffer, frame.byteOffset + 257, 5).toString("latin1") === "ustar"
        );
    }

    return false;
}

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export interface TarEntry {
    /** Path inside the archive, `/`-separated, without a trailing slash. */
    path: string;
    type: TarEntryType;
    size: number;
    linkTarget?: string;
    /** sha256 of a file's content, when the listing was asked to hash. */
    sha256?: string;
}

const BLOCK = 512;

function cString(block: Uint8Array, offset: number, length: number): string {
    let end = offset;

    while (end < offset + length && block[end] !== 0) {
        end++;
    }

    return Buffer.from(block.buffer, block.byteOffset + offset, end - offset).toString("utf8");
}

function numericField(block: Uint8Array, offset: number, length: number): number {
    // GNU base-256: the high bit of the first byte is set, the rest is a big-endian number.
    if ((block[offset] ?? 0) & 0x80) {
        let value = (block[offset] ?? 0) & 0x7f;

        for (let index = 1; index < length; index++) {
            value = value * 256 + (block[offset + index] ?? 0);
        }

        return value;
    }

    const text = cString(block, offset, length).trim();

    if (text !== "" && !/^[0-7]+$/.test(text)) {
        throw new Error("invalid tar numeric field");
    }

    return text === "" ? 0 : Number.parseInt(text, 8);
}

function parsePax(bytes: Uint8Array): Record<string, string> {
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    const records: Record<string, string> = {};
    let at = 0;

    while (at < text.length) {
        const space = text.indexOf(32, at);

        if (space === -1) {
            break;
        }

        const length = Number.parseInt(text.toString("utf8", at, space), 10);

        if (!Number.isFinite(length) || length <= 0) {
            break;
        }

        const record = text.toString("utf8", space + 1, at + length - 1);
        const equals = record.indexOf("=");

        if (equals > 0) {
            records[record.slice(0, equals)] = record.slice(equals + 1);
        }

        at += length;
    }

    return records;
}

function entryType(flag: number): TarEntryType {
    switch (String.fromCharCode(flag)) {
        case "0":
        case "\0":
        case "7":
            return "file";
        case "5":
            return "directory";
        case "2":
            return "symlink";
        case "1":
            return "hardlink";
        default:
            return "other";
    }
}

/**
 * A streaming tar reader that lists entries (ustar, pax `x` headers, GNU `L`/`K` long names) from chunks of any size,
 * so a multi-GB archive is listed with one chunk in memory. Written here, not taken from `tar -tv`, because the
 * verbose listing differs between bsdtar and GNU tar.
 */
export class TarLister {
    readonly entries: TarEntry[] = [];
    private readonly hash: boolean;
    private header = Buffer.alloc(BLOCK);
    private headerFill = 0;
    private remaining = 0;
    private padding = 0;
    private zeroBlocks = 0;
    private done = false;
    private current: TarEntry | null = null;
    private hasher: Bun.CryptoHasher | null = null;
    private meta: { kind: "pax" | "long-name" | "long-link" | "skip"; chunks: Uint8Array[] } | null = null;
    private pax: Record<string, string> = {};
    private longName: string | undefined;
    private longLink: string | undefined;

    constructor({ hash = false }: { hash?: boolean } = {}) {
        this.hash = hash;
    }

    get finished(): boolean {
        return this.done;
    }

    push(chunk: Uint8Array): void {
        let at = 0;

        while (at < chunk.length && !this.done) {
            if (this.remaining > 0) {
                const take = Math.min(this.remaining, chunk.length - at);
                this.consumeData(chunk.subarray(at, at + take));
                this.remaining -= take;
                at += take;

                if (this.remaining === 0) {
                    this.endData();
                }

                continue;
            }

            if (this.padding > 0) {
                const take = Math.min(this.padding, chunk.length - at);
                this.padding -= take;
                at += take;
                continue;
            }

            const take = Math.min(BLOCK - this.headerFill, chunk.length - at);
            this.header.set(chunk.subarray(at, at + take), this.headerFill);
            this.headerFill += take;
            at += take;

            if (this.headerFill === BLOCK) {
                this.headerFill = 0;
                this.readHeader();
            }
        }
    }

    private readHeader(): void {
        const block = this.header;

        if (block.every((byte) => byte === 0)) {
            if (Object.keys(this.pax).length > 0 || this.longName !== undefined || this.longLink !== undefined) {
                throw new Error("tar metadata has no following entry");
            }

            this.zeroBlocks += 1;
            this.done = this.zeroBlocks >= 2;
            return;
        }

        this.zeroBlocks = 0;
        const expectedChecksum = numericField(block, 148, 8);
        let checksum = 0;

        for (let index = 0; index < BLOCK; index++) {
            checksum += index >= 148 && index < 156 ? 32 : block[index]!;
        }

        if (checksum !== expectedChecksum) {
            throw new Error("invalid tar header checksum");
        }

        const flag = block[156] ?? 0;
        const size = numericField(block, 124, 12);

        if (!Number.isSafeInteger(size) || size < 0) {
            throw new Error("invalid tar entry size");
        }

        const kind = String.fromCharCode(flag);
        this.padding = (BLOCK - (size % BLOCK)) % BLOCK;

        if (kind === "x" || kind === "g" || kind === "L" || kind === "K") {
            const metaKind = kind === "x" ? "pax" : kind === "L" ? "long-name" : kind === "K" ? "long-link" : "skip";
            this.meta = { kind: metaKind, chunks: [] };
            this.remaining = size;

            if (size === 0) {
                this.endData();
            }

            return;
        }

        const name = cString(block, 0, 100);
        const prefix = cString(block, 345, 155);
        const rawPath = this.pax.path ?? this.longName ?? (prefix ? `${prefix}/${name}` : name);
        const realSize = this.pax.size !== undefined ? Number(this.pax.size) : size;

        if (
            !Number.isSafeInteger(realSize) ||
            realSize < 0 ||
            (this.pax.size !== undefined && !/^\d+$/.test(this.pax.size))
        ) {
            throw new Error("invalid tar entry size");
        }

        const linkTarget = this.pax.linkpath ?? this.longLink ?? cString(block, 157, 100);
        const type = entryType(flag);
        this.pax = {};
        this.longName = undefined;
        this.longLink = undefined;

        const entry: TarEntry = {
            path: rawPath.replace(/^\.\//, "").replace(/\/+$/, ""),
            type,
            size: type === "file" ? realSize : 0,
        };

        if (type === "symlink" || type === "hardlink") {
            entry.linkTarget = linkTarget;
        }

        this.entries.push(entry);
        this.padding = (BLOCK - (realSize % BLOCK)) % BLOCK;
        this.remaining = realSize;
        this.current = entry;
        this.hasher = this.hash && type === "file" ? new Bun.CryptoHasher("sha256") : null;

        if (realSize === 0) {
            this.endData();
        }
    }

    private consumeData(bytes: Uint8Array): void {
        if (this.meta) {
            if (this.meta.kind !== "skip") {
                this.meta.chunks.push(new Uint8Array(bytes));
            }

            return;
        }

        this.hasher?.update(bytes);
    }

    private endData(): void {
        if (this.meta) {
            const bytes = Buffer.concat(this.meta.chunks);

            if (this.meta.kind === "pax") {
                this.pax = parsePax(bytes);
            } else if (this.meta.kind === "long-name") {
                this.longName = cString(bytes, 0, bytes.length);
            } else if (this.meta.kind === "long-link") {
                this.longLink = cString(bytes, 0, bytes.length);
            }

            this.meta = null;
            return;
        }

        if (this.current && this.hasher) {
            this.current.sha256 = this.hasher.digest("hex");
        }

        this.current = null;
        this.hasher = null;
    }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
}

export interface PackResult {
    archive: string;
    /** Bytes of the tar stream (the folder's content plus tar headers). */
    tarBytes: number;
    compressedBytes: number;
    frames: number;
}

/** Refuses an output inside the folder being archived, including paths through a symlinked parent. */
export function assertArchiveOutsideSource(source: string, archive: string): void {
    // The atomic writer creates a sibling temp file and replaces the last component, including a symlink.
    const output = resolve(archive);
    const parent = dirname(output);
    const { ancestor, value: canonicalParent } = readExistingAncestorSync(parent, (path) => realpathSync(path));
    const canonicalTarget = resolve(canonicalParent, relative(ancestor, parent), basename(output));
    const child = relative(realpathSync(source), canonicalTarget);

    if (child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))) {
        throw new Error(`archive output must be outside the source folder: ${archive}`);
    }
}

/**
 * Packs a folder into one `.tar.zst` with the system `tar` (bsdtar on macOS and Windows, GNU tar on Linux) streamed
 * into seekable zstd frames, through a temp file and a rename: the folder is never held in memory and a failed or
 * interrupted pack never leaves a truncated archive under the final name. The archive holds one top folder, named
 * after the source folder. Extended attributes are left out (`--no-xattrs`, `COPYFILE_DISABLE=1`).
 */
export async function packDirectory({
    source: inputSource,
    archive: inputArchive,
    frameBytes,
    threads,
    ...params
}: ZstdParams & {
    source: string;
    archive?: string;
    frameBytes?: number;
    threads?: number;
}): Promise<PackResult> {
    const source = resolve(inputSource);
    const archive = inputArchive ?? `${source}${FOLDER_ARCHIVE_SUFFIX}`;
    assertArchiveOutsideSource(source, archive);
    const result: PackResult = { archive, tarBytes: 0, compressedBytes: 0, frames: 0 };

    await atomicWriteFileStreamed(
        archive,
        async (write) => {
            const writer = new SeekableZstdWriter({ write, frameBytes, threads, ...params });
            const proc = Bun.spawn(["tar", "--no-xattrs", "-cf", "-", "-C", dirname(source), basename(source)], {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...env.getProcessEnv(), COPYFILE_DISABLE: "1" },
            });
            const stderr = drain(proc.stderr);

            for await (const chunk of proc.stdout) {
                await writer.push(chunk);
            }

            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                throw new Error(`tar failed packing ${source} (exit ${exitCode}): ${(await stderr).trim()}`);
            }

            const stats = await writer.finish();
            result.tarBytes = stats.inputBytes;
            result.compressedBytes = stats.outputBytes;
            result.frames = stats.frames;
        },
        { mode: 0o600 }
    );

    return result;
}

/** Lists a `.tar.zst` (entry paths, types, sizes; `hash` adds each file's sha256), one frame in memory at a time. */
export function listArchive(archive: string, { hash = false }: { hash?: boolean } = {}): TarEntry[] {
    const lister = new TarLister({ hash });

    for (const frame of readZstdFramesSync(archive)) {
        lister.push(frame);
    }

    if (!lister.finished) {
        throw new Error("incomplete tar archive: missing data, padding or end markers");
    }

    return lister.entries;
}

/**
 * Unpacks a `.tar.zst` into `destination` (created when missing) with the system `tar`, fed one decompressed frame at
 * a time. The archive's top folder lands inside `destination`.
 */
export async function unpackArchive({ archive, destination }: { archive: string; destination: string }): Promise<void> {
    mkdirSync(destination, { recursive: true });
    const proc = Bun.spawn(["tar", "-kxf", "-", "-C", destination], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stderr = drain(proc.stderr);
    const stdout = drain(proc.stdout);

    try {
        for (const frame of readZstdFramesSync(archive)) {
            proc.stdin.write(frame);
            await proc.stdin.flush();
        }
    } finally {
        await proc.stdin.end();
    }

    const exitCode = await proc.exited;
    await stdout;

    if (exitCode !== 0) {
        throw new Error(
            `tar failed unpacking ${archive} into ${destination} (exit ${exitCode}): ${(await stderr).trim()}`
        );
    }
}

interface WalkedEntry {
    type: TarEntryType;
    size: number;
    linkTarget?: string;
    absolute: string;
}

/** Every entry under `root`, keyed by its archive path (`<basename>/<relative>` with `/` separators). */
function walkFolder(root: string): Map<string, WalkedEntry> {
    const entries = new Map<string, WalkedEntry>();
    const top = basename(root);
    entries.set(top, { type: "directory", size: 0, absolute: root });
    const stack: Array<{ absolute: string; key: string }> = [{ absolute: root, key: top }];

    while (stack.length > 0) {
        const { absolute, key } = stack.pop()!;

        for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
            const childAbsolute = join(absolute, dirent.name);
            const childKey = `${key}/${dirent.name}`;

            if (dirent.isDirectory()) {
                entries.set(childKey, { type: "directory", size: 0, absolute: childAbsolute });
                stack.push({ absolute: childAbsolute, key: childKey });
            } else if (dirent.isSymbolicLink()) {
                entries.set(childKey, {
                    type: "symlink",
                    size: 0,
                    linkTarget: readlinkSync(childAbsolute),
                    absolute: childAbsolute,
                });
            } else if (dirent.isFile()) {
                entries.set(childKey, { type: "file", size: lstatSync(childAbsolute).size, absolute: childAbsolute });
            } else {
                entries.set(childKey, { type: "other", size: 0, absolute: childAbsolute });
            }
        }
    }

    return entries;
}

export interface ArchiveCheck {
    /** True when every file, folder and link of the source is in the archive with the same size (and content). */
    ok: boolean;
    entries: number;
    /** In the folder, not in the archive. */
    missing: string[];
    /** In both, with another type, size, link target or (with `content`) sha256. */
    mismatched: string[];
    /** In the archive, not in the folder (the folder lost an entry after packing). */
    extra: string[];
}

/**
 * Checks a `.tar.zst` from {@link packDirectory} against the folder it was made from, before the folder is removed:
 * every entry must be listed with the same type and size, and with `content` (the default) every file's sha256 must
 * match too, which reads the folder and the archive once each.
 */
export function verifyArchiveAgainstFolder({
    archive,
    source,
    content = true,
}: {
    archive: string;
    source: string;
    content?: boolean;
}): ArchiveCheck {
    const listed = new Map(listArchive(archive, { hash: content }).map((entry) => [entry.path, entry]));
    const walked = walkFolder(source);
    const missing: string[] = [];
    const mismatched: string[] = [];

    for (const [key, entry] of walked) {
        const inArchive = listed.get(key);

        if (!inArchive) {
            missing.push(key);
            continue;
        }

        // tar stores the second name of a hard-linked file as a link to the first, with no content of its own.
        let stored = inArchive;
        const visited = new Set<string>();

        while (stored.type === "hardlink" && stored.linkTarget && !visited.has(stored.path)) {
            visited.add(stored.path);
            const target = listed.get(stored.linkTarget.replace(/^\.\//, "").replace(/\/+$/, ""));

            if (!target) {
                break;
            }

            stored = target;
        }

        const sameShape =
            stored.type === entry.type &&
            stored.size === entry.size &&
            (entry.type !== "symlink" || inArchive.linkTarget === entry.linkTarget);
        const sameContent = !content || entry.type !== "file" || stored.sha256 === sha256File(entry.absolute);

        if (!sameShape || !sameContent) {
            mismatched.push(key);
        }
    }

    const extra = [...listed.keys()].filter((key) => !walked.has(key));
    return {
        ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0,
        entries: listed.size,
        missing,
        mismatched,
        extra,
    };
}
