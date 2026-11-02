import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, type Stats, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { env } from "@genesiscz/utils/env";
import { sha256File } from "@genesiscz/utils/fs/hash";
import { atomicWriteFileStreamed } from "@genesiscz/utils/storage/atomic-file";
import { readExistingAncestorSync, type SourceStat, sameSource } from "./file";
import { PRESETS } from "./presets";
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

function decimalField(value: string, field: string): number {
    const number = Number(value);

    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
        throw new Error(`invalid tar ${field}`);
    }

    return number;
}

/**
 * The real name and size of a GNU sparse 1.0 entry, from its pax header, or null for an entry without GNU sparse keys.
 * bsdtar writes this form for a file with holes; any other sparse form (0.0, 0.1) throws rather than being listed
 * under its stand-in name.
 */
function gnuSparse(pax: Record<string, string>): { name: string; realSize: number } | null {
    if (!Object.keys(pax).some((key) => key.startsWith("GNU.sparse."))) {
        return null;
    }

    const major = pax["GNU.sparse.major"];
    const minor = pax["GNU.sparse.minor"];
    const name = pax["GNU.sparse.name"];
    const realSize = pax["GNU.sparse.realsize"];

    if (major !== "1" || minor !== "0") {
        throw new Error(`unsupported GNU sparse format ${major ?? "?"}.${minor ?? "?"}`);
    }

    if (name === undefined || realSize === undefined) {
        throw new Error("GNU sparse 1.0 entry without its name or real size");
    }

    return { name, realSize: decimalField(realSize, "GNU sparse real size") };
}

const ZEROS = new Uint8Array(1024 * 1024);

/**
 * The body of a GNU sparse 1.0 entry: a map (the segment count, then each segment's offset and size, one decimal
 * number per line, padded to a block), then the stored segments back to back. Rebuilds the file's content for the
 * hash, with zeros in the holes, and throws on a map that does not account for every stored byte.
 */
class GnuSparseBody {
    private readonly segments: Array<{ offset: number; size: number }> = [];
    private numbers = 0;
    private expected = 1;
    private value = 0;
    private digits = 0;
    private pendingOffset = 0;
    private mapBytes = 0;
    private mapPadding = -1;
    private segment = 0;
    private segmentDone = 0;
    private position = 0;
    private end = 0;

    constructor(
        private readonly realSize: number,
        private readonly storedSize: number,
        private readonly hasher: Bun.CryptoHasher | null
    ) {}

    push(bytes: Uint8Array): void {
        let at = 0;

        while (at < bytes.length) {
            if (this.mapPadding < 0) {
                this.readMapByte(bytes[at]!);
                at++;
                continue;
            }

            if (this.mapPadding > 0) {
                const take = Math.min(this.mapPadding, bytes.length - at);
                this.mapPadding -= take;
                at += take;
                continue;
            }

            const segment = this.segments[this.segment];

            if (!segment) {
                throw new Error("GNU sparse data runs past its map");
            }

            this.zeroFill(segment.offset);
            const take = Math.min(segment.size - this.segmentDone, bytes.length - at);
            this.hasher?.update(bytes.subarray(at, at + take));
            this.segmentDone += take;
            this.position += take;
            at += take;

            if (this.segmentDone === segment.size) {
                this.segment++;
                this.segmentDone = 0;
            }
        }
    }

    /** Called when the entry's stored bytes end: the map and every segment must be complete. */
    finish(): void {
        if (this.mapPadding !== 0 || this.segment !== this.segments.length) {
            throw new Error("GNU sparse entry ends before its map or data");
        }

        this.zeroFill(this.realSize);
    }

    private readMapByte(byte: number): void {
        this.mapBytes++;

        if (byte >= 0x30 && byte <= 0x39 && this.digits < 16) {
            this.value = this.value * 10 + (byte - 0x30);
            this.digits++;
            return;
        }

        if (byte !== 0x0a || this.digits === 0 || !Number.isSafeInteger(this.value)) {
            throw new Error("invalid GNU sparse map");
        }

        const value = this.value;
        this.value = 0;
        this.digits = 0;
        this.numbers++;

        if (this.numbers === 1) {
            this.expected = 1 + 2 * value;
        } else if (this.numbers % 2 === 0) {
            this.pendingOffset = value;
        } else {
            this.addSegment(this.pendingOffset, value);
        }

        if (this.numbers === this.expected) {
            this.mapPadding = (BLOCK - (this.mapBytes % BLOCK)) % BLOCK;
            const data = this.segments.reduce((sum, segment) => sum + segment.size, 0);

            if (this.mapBytes + this.mapPadding + data !== this.storedSize) {
                throw new Error("GNU sparse map does not match the stored data");
            }
        }
    }

    private addSegment(offset: number, size: number): void {
        if (offset < this.end || offset + size > this.realSize) {
            throw new Error("GNU sparse map segments overlap or run past the real size");
        }

        this.end = offset + size;

        // A segment without data (bsdtar ends every map with `<real size> 0`) only marks where a hole ends.
        if (size > 0) {
            this.segments.push({ offset, size });
        }
    }

    private zeroFill(to: number): void {
        if (!this.hasher) {
            this.position = Math.max(this.position, to);
            return;
        }

        while (this.position < to) {
            const take = Math.min(to - this.position, ZEROS.length);
            this.hasher.update(ZEROS.subarray(0, take));
            this.position += take;
        }
    }
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
 * A streaming tar reader that lists entries (ustar, pax `x` headers, GNU `L`/`K` long names, GNU sparse 1.0 files
 * under their real name and size) from chunks of any size, so a multi-GB archive is listed with one chunk in memory.
 * Written here, not taken from `tar -tv`, because the verbose listing differs between bsdtar and GNU tar.
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
    private sparse: GnuSparseBody | null = null;
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
        const type = entryType(flag);
        // A sparse file's ustar name is a stand-in (`<dir>/GNUSparseFile.0/<name>`); its pax header holds the real one.
        const sparse = gnuSparse(this.pax);

        if (sparse && type !== "file") {
            throw new Error("GNU sparse header on an entry that is not a file");
        }

        const rawPath = sparse?.name ?? this.pax.path ?? this.longName ?? (prefix ? `${prefix}/${name}` : name);
        const storedSize = this.pax.size !== undefined ? decimalField(this.pax.size, "entry size") : size;
        const linkTarget = this.pax.linkpath ?? this.longLink ?? cString(block, 157, 100);
        this.pax = {};
        this.longName = undefined;
        this.longLink = undefined;

        const entry: TarEntry = {
            path: rawPath.replace(/^\.\//, "").replace(/\/+$/, ""),
            type,
            size: type === "file" ? (sparse?.realSize ?? storedSize) : 0,
        };

        if (type === "symlink" || type === "hardlink") {
            entry.linkTarget = linkTarget;
        }

        this.entries.push(entry);
        this.padding = (BLOCK - (storedSize % BLOCK)) % BLOCK;
        this.remaining = storedSize;
        this.current = entry;
        this.hasher = this.hash && type === "file" ? new Bun.CryptoHasher("sha256") : null;
        this.sparse = sparse ? new GnuSparseBody(sparse.realSize, storedSize, this.hasher) : null;

        if (storedSize === 0) {
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

        if (this.sparse) {
            this.sparse.push(bytes);
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

        this.sparse?.finish();

        if (this.current && this.hasher) {
            this.current.sha256 = this.hasher.digest("hex");
        }

        this.current = null;
        this.hasher = null;
        this.sparse = null;
    }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
}

/**
 * The `tar -c` call that packs a folder, or only `files` of it (paths relative to the folder, `/` separators). A list
 * is packed under the folder's name with each file's parent folders and nothing else (`--no-recursion`), so the
 * archive keeps the one top folder that unpack expects. `COPYFILE_DISABLE=1` keeps macOS bsdtar from adding
 * AppleDouble entries.
 *
 * Every name reaches tar NUL-separated on stdin (`--null -T -`), never as an argument, and `-C` always gets an
 * absolute path: a folder named `-x` as an argument is read as an option, and bsdtar reads an argument that starts
 * with `-C` as a folder change and one that starts with `@` as an archive to copy in, even after `--` (a folder named
 * `-Cx` packed into an empty archive with exit 0). With `--null` both tars take each listed name as it is: no option,
 * no `-C` line, no unquoting (GNU tar also needs {@link TAR_OPTIONS} `namesFromList` for backslashes).
 */
export function tarCreateCommand(
    source: string,
    files?: readonly string[]
): { cmd: string[]; stdin: Uint8Array; env: Record<string, string | undefined> } {
    const folder = resolve(source);
    const top = basename(folder);
    const names = [top];

    if (files) {
        names.push(...[...parentFolders(files)].sort().map((parent) => `${top}/${parent}`));
        names.push(...files.map((file) => `${top}/${file}`));
    }

    return {
        cmd: [
            "tar",
            "--no-xattrs",
            ...(files ? ["--no-recursion"] : []),
            "--null",
            ...TAR_OPTIONS[tarFlavor()].namesFromList,
            "-cf",
            "-",
            "-C",
            dirname(folder),
            "-T",
            "-",
        ],
        stdin: Buffer.from(`${names.join("\0")}\0`),
        env: { ...env.getProcessEnv(), COPYFILE_DISABLE: "1" },
    };
}

/** Every parent folder of the listed files, relative to the packed folder. */
function parentFolders(files: readonly string[]): Set<string> {
    const folders = new Set<string>();

    for (const file of files) {
        const parts = file.split("/");

        for (let depth = 1; depth < parts.length; depth++) {
            folders.add(parts.slice(0, depth).join("/"));
        }
    }

    return folders;
}

export interface PackResult {
    archive: string;
    /** Bytes of the tar stream (the folder's content plus tar headers). */
    tarBytes: number;
    compressedBytes: number;
    frames: number;
    /** sha256 of the tar stream, hashed while it was written: what decompressing the archive gives back. */
    sha256: string;
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
 * after the source folder; with `files`, only those files of it (see {@link tarCreateCommand}). Extended attributes are left out (`--no-xattrs`). `COPYFILE_DISABLE=1` stops macOS bsdtar
 * from adding an AppleDouble `._name` entry per file, and without it bsdtar also skipped a real `._name` file. bsdtar
 * stores a file with holes as GNU sparse 1.0, which {@link TarLister} reads. Level, long mode, frame size and threads
 * that a caller leaves out come from the `tree` preset.
 */
export async function packDirectory({
    source: inputSource,
    archive: inputArchive,
    level = PRESETS.tree.level,
    long = PRESETS.tree.long,
    checksum,
    frameBytes = PRESETS.tree.frameBytes,
    threads = PRESETS.tree.threads,
    files,
}: ZstdParams & {
    source: string;
    archive?: string;
    frameBytes?: number;
    threads?: number;
    /** Pack only these files of the folder: paths relative to it, `/` separators, no folders. */
    files?: readonly string[];
}): Promise<PackResult> {
    const source = resolve(inputSource);
    const archive = inputArchive ?? `${source}${FOLDER_ARCHIVE_SUFFIX}`;
    assertArchiveOutsideSource(source, archive);
    const result: PackResult = { archive, tarBytes: 0, compressedBytes: 0, frames: 0, sha256: "" };

    await atomicWriteFileStreamed(
        archive,
        async (write) => {
            const writer = new SeekableZstdWriter({ write, frameBytes, threads, level, long, checksum });
            const tar = tarCreateCommand(source, files);
            const proc = Bun.spawn(tar.cmd, {
                stdin: tar.stdin,
                stdout: "pipe",
                stderr: "pipe",
                env: tar.env,
            });
            const stderr = drain(proc.stderr);
            const hasher = new Bun.CryptoHasher("sha256");

            for await (const chunk of proc.stdout) {
                hasher.update(chunk);
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
            result.sha256 = hasher.digest("hex");
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

type TarFlavor = "bsdtar" | "gnu" | "other";

let systemTarFlavor: TarFlavor | undefined;

/** Which `tar` is on PATH, asked once per process: bsdtar (macOS, Windows), GNU tar (most Linux) or another one. */
function tarFlavor(): TarFlavor {
    if (systemTarFlavor === undefined) {
        const version = Bun.spawnSync(["tar", "--version"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
        systemTarFlavor = version.includes("bsdtar") ? "bsdtar" : version.includes("GNU tar") ? "gnu" : "other";
    }

    return systemTarFlavor;
}

/**
 * The options each system `tar` needs here.
 *
 * `extract`: bsdtar on macOS reads every `._name` entry as AppleDouble metadata (libarchive's `mac-ext`, on by default
 * where copyfile exists): it writes no file for it and applies its bytes to the entry that follows, so a real `._name`
 * file from the folder vanished on unpack, or the unpack failed on the next entry's metadata. `COPYFILE_DISABLE` and
 * `--no-mac-metadata` leave that reading on; `tar:!mac-ext` turns it off. GNU tar has no `--options` and does not read
 * `._` entries that way.
 *
 * `namesFromList`: GNU tar unquotes the names it reads with `-T` (`\\`, `\n`, `\b` and octal escapes), so a listed
 * file named `a\b` would be read as another name; `--no-unquote` takes each name as it is. bsdtar takes them as they
 * are. Neither reads a listed name as an option under `--null`: GNU tar documents that `--null` turns that off like
 * `--verbatim-files-from` (which GNU tar before 1.29 does not know), and bsdtar's `--null` turns off its `-C` lines.
 */
const TAR_OPTIONS: Record<TarFlavor, { extract: readonly string[]; namesFromList: readonly string[] }> = {
    bsdtar: { extract: process.platform === "darwin" ? ["--options", "tar:!mac-ext"] : [], namesFromList: [] },
    gnu: { extract: [], namesFromList: ["--no-unquote"] },
    other: { extract: [], namesFromList: [] },
};

function extractOptions(): readonly string[] {
    // Only macOS needs an extract option, so nothing else spawns `tar --version` for an unpack.
    return process.platform === "darwin" ? TAR_OPTIONS[tarFlavor()].extract : [];
}

/**
 * Unpacks a `.tar.zst` into `destination` (created when missing) with the system `tar`, fed one decompressed frame at
 * a time. The archive's top folder lands inside `destination`. A `._name` entry is restored as the file it was.
 * Returns the size and sha256 of the tar stream tar was fed, hashed on the way.
 */
export async function unpackArchive({
    archive,
    destination,
}: {
    archive: string;
    destination: string;
}): Promise<{ bytes: number; sha256: string }> {
    mkdirSync(destination, { recursive: true });
    // Absolute, so a destination named `-x` never reaches tar looking like an option.
    const proc = Bun.spawn(["tar", ...extractOptions(), "-kxf", "-", "-C", resolve(destination)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    const stderr = drain(proc.stderr);
    const stdout = drain(proc.stdout);
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;

    try {
        for (const frame of readZstdFramesSync(archive)) {
            hasher.update(frame);
            bytes += frame.length;
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

    return { bytes, sha256: hasher.digest("hex") };
}

interface WalkedEntry {
    type: TarEntryType;
    size: number;
    linkTarget?: string;
    absolute: string;
    /** The entry's identity when the walk saw it, before its content was compared. */
    seen: SourceStat;
}

function identity(stat: Stats): SourceStat {
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

/** The entry at `absolute` as the walk records it, from `lstat` (a symlink is not followed). */
function entryAt(absolute: string): WalkedEntry {
    const stat = lstatSync(absolute);
    const seen = identity(stat);

    if (stat.isDirectory()) {
        return { type: "directory", size: 0, absolute, seen };
    }

    if (stat.isSymbolicLink()) {
        return { type: "symlink", size: 0, linkTarget: readlinkSync(absolute), absolute, seen };
    }

    return stat.isFile()
        ? { type: "file", size: stat.size, absolute, seen }
        : { type: "other", size: 0, absolute, seen };
}

/** The packed folder itself: always the top folder of the archive, and followed, as the pack reads it. */
function topEntry(root: string): WalkedEntry {
    return { type: "directory", size: 0, absolute: root, seen: identity(statSync(root)) };
}

/** The entries a pack of `files` holds, keyed like {@link walkFolder}: the top folder, the parent folders, the files. */
function walkFiles(root: string, files: readonly string[]): Map<string, WalkedEntry> {
    const top = basename(root);
    const entries = new Map<string, WalkedEntry>([[top, topEntry(root)]]);

    for (const path of [...parentFolders(files), ...files]) {
        entries.set(`${top}/${path}`, entryAt(join(root, path)));
    }

    return entries;
}

/** Every entry under `root`, keyed by its archive path (`<basename>/<relative>` with `/` separators). */
function walkFolder(root: string): Map<string, WalkedEntry> {
    const entries = new Map<string, WalkedEntry>();
    const top = basename(root);
    entries.set(top, topEntry(root));
    const stack: Array<{ absolute: string; key: string }> = [{ absolute: root, key: top }];

    while (stack.length > 0) {
        const { absolute, key } = stack.pop()!;

        for (const name of readdirSync(absolute)) {
            const childAbsolute = join(absolute, name);
            const childKey = `${key}/${name}`;
            // A folder's identity too: a file created in it after the check changes the folder's mtime.
            const entry = entryAt(childAbsolute);
            entries.set(childKey, entry);

            if (entry.type === "directory") {
                stack.push({ absolute: childAbsolute, key: childKey });
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
    /** Each compared entry of the folder by absolute path, as `lstat` saw it before any content was compared. */
    seen: Map<string, SourceStat>;
}

/**
 * The entries of a checked folder that are no longer what the check saw (written, replaced, gone, or a folder that
 * gained or lost an entry), so a removal after the check leaves them: a file appended after its sha256 matched while
 * later files were still being hashed is not in the archive. `paths` (absolute) limits it to the entries a removal
 * takes; a list pack removes only its files.
 */
export function changedSinceCheck(check: ArchiveCheck, paths?: readonly string[]): string[] {
    return (paths ?? [...check.seen.keys()]).filter((path) => {
        const before = check.seen.get(path);
        const now = lstatSync(path, { throwIfNoEntry: false });
        return !before || !now || !sameSource(now, before);
    });
}

/**
 * Checks a `.tar.zst` from {@link packDirectory} against the folder it was made from, before the folder is removed:
 * every entry must be listed with the same type and size, and with `content` (the default) every file's sha256 must
 * match too, which reads the folder and the archive once each. With `files` (the list the pack was made from) the
 * folder's other entries are not compared.
 */
export function verifyArchiveAgainstFolder({
    archive,
    source,
    content = true,
    files,
}: {
    archive: string;
    source: string;
    content?: boolean;
    files?: readonly string[];
}): ArchiveCheck {
    const listed = new Map(listArchive(archive, { hash: content }).map((entry) => [entry.path, entry]));
    const walked = files ? walkFiles(source, files) : walkFolder(source);
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
        seen: new Map([...walked.values()].map((entry) => [entry.absolute, entry.seen])),
    };
}
