import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { concurrentMap, withTimeout } from "@genesiscz/utils/async";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * The Clicky sound library the app ships: `registry.json`, and per set its `manifest.json`, licence files and ONE
 * lossless FLAC (`samples.flac`) holding every sample in manifest order. 4,400 short WAVs are 37.8 MB; one FLAC per
 * set is 9.6 MB, and per-sample FLAC (13.6 MB) or lossy Opus/AAC (10 to 25 MB, a container per 60 ms clip) are
 * larger. Above Martin's 5 MB limit for the repository, so the packed library is a GitHub release asset
 * (`clicky-library-<n>`), pinned by `src/macos/GenesisTools/ClickyLibrary.json` (URL, size, SHA-256). The app build
 * downloads it once into the tools cache and gets the WAVs back, byte for byte, because the Swift loader
 * (GenesisKit `ClickyPacks.swift`) reads only PCM16 WAV whose SHA-256 matches the manifest.
 *
 * A new library version: `pack <source> <out>`, then `archive <out> <file.tar.gz> clicky-library-<n>` (prints the
 * pin), `gh release create clicky-library-<n> <file.tar.gz> --latest=false`, and commit the printed pin.
 */
export const CLICKY_PACKED_SAMPLES = "samples.flac";

const SAMPLE_RATE = 48_000;
const HEADER_BYTES = 44;
/** `flac` settings measured on the shipped library: 9.59 MB, against 9.95 MB at the default block size. */
const FLAC_ARGS = ["-8", "-e", "-p", "-b", "1152", "--no-padding", "--silent", "--force"];

const { log } = logger.scoped("clicky-library");

interface ManifestFile {
    filename: string;
    sha256: string;
    frames: number;
}

interface Manifest {
    id: string;
    files: ManifestFile[];
}

interface Registry {
    sets: { id: string }[];
}

/** `src/macos/GenesisTools/ClickyLibrary.json`: which release asset holds the packed library. */
export interface ClickyLibraryPin {
    release: string;
    url: string;
    sha256: string;
    bytes: number;
    sets: number;
    samples: number;
}

/** The only failure a first app build may tolerate by omitting the library. */
export class ClickyLibraryUnavailableError extends Error {}

const RELEASE_BASE = "https://github.com/genesiscz/GenesisTools/releases/download";

/** A canonical 44-byte header for mono 48 kHz PCM16, the layout the library's WAVs use. */
export function wavHeader(pcmBytes: number): Buffer {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcmBytes, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcmBytes, 40);
    return header;
}

/** The PCM of a mono 48 kHz PCM16 WAV, whatever chunks surround it (afconvert adds `FLLR` padding). */
export function wavPCM(bytes: Buffer, name: string): Buffer {
    if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") {
        throw new Error(`${name}: not a WAV file`);
    }

    let offset = 12;
    let format = false;
    while (offset + 8 <= bytes.length) {
        const tag = bytes.toString("latin1", offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (tag === "fmt ") {
            const channels = bytes.readUInt16LE(start + 2);
            const rate = bytes.readUInt32LE(start + 4);
            const bits = bytes.readUInt16LE(start + 14);
            if (channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
                throw new Error(
                    `${name}: expected mono ${SAMPLE_RATE} Hz PCM16, got ${channels} ch ${rate} Hz ${bits} bit`
                );
            }

            format = true;
        }

        if (tag === "data") {
            if (!format) {
                throw new Error(`${name}: data before fmt`);
            }

            return bytes.subarray(start, start + size);
        }

        offset = start + size + (size % 2);
    }

    throw new Error(`${name}: no data chunk`);
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function readJSON<T>(path: string): T {
    return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as T;
}

async function run(cmd: string[], environment?: Record<string, string>): Promise<void> {
    const proc = Bun.spawn(cmd, {
        stdout: "ignore",
        stderr: "pipe",
        env: environment ? { ...env.getProcessEnv(), ...environment } : undefined,
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
        throw new Error(`${cmd[0]} exited ${code}: ${stderr.trim()}`);
    }
}

function setIDs(root: string): string[] {
    return readJSON<Registry>(join(root, "registry.json")).sets.map((set) => set.id);
}

/** Runs `fn` for every set, 8 at a time, and throws every failure together (`concurrentMap` alone skips them). */
async function eachSet(ids: string[], fn: (id: string) => Promise<void>): Promise<void> {
    const failures: string[] = [];
    await concurrentMap({
        items: ids,
        concurrency: 8,
        fn,
        onError: (id, error) => failures.push(error instanceof Error ? error.message : `${id}: ${String(error)}`),
    });
    if (failures.length > 0) {
        throw new Error(`Clicky library: ${failures.length} set(s) failed:\n${failures.join("\n")}`);
    }
}

/**
 * Packs a library folder (`registry.json`, `<set>/manifest.json`, `<set>/*.wav`, licences) into `out`: the metadata
 * copied as it is, the samples of each set as one FLAC in manifest order. Needs the `flac` encoder (`brew install
 * flac`); run it once when the library changes (`bun src/macos/lib/clicky-library.ts pack <source> <out>`).
 */
export async function packClickyLibrary(source: string, out: string): Promise<{ sets: number; bytes: number }> {
    mkdirSync(out, { recursive: true });
    cpSync(join(source, "registry.json"), join(out, "registry.json"));
    const scratch = mkdtempSync(join(tmpdir(), "gt-clicky-pack-"));
    let bytes = 0;
    try {
        const ids = setIDs(source);
        await eachSet(ids, async (id) => {
            const from = join(source, id);
            const to = join(out, id);
            mkdirSync(to, { recursive: true });
            for (const name of readdirSync(from)) {
                if (!name.endsWith(".wav") && statSync(join(from, name)).isFile()) {
                    cpSync(join(from, name), join(to, name));
                }
            }

            const manifest = readJSON<Manifest>(join(from, "manifest.json"));
            const parts = manifest.files.map((file) => {
                const pcm = wavPCM(readFileSync(join(from, file.filename)), `${id}/${file.filename}`);
                if (pcm.length !== file.frames * 2) {
                    throw new Error(
                        `${id}/${file.filename}: ${pcm.length / 2} frames, the manifest says ${file.frames}`
                    );
                }

                return pcm;
            });
            const pcm = Buffer.concat(parts);
            const joined = join(scratch, `${id}.wav`);
            writeFileSync(joined, Buffer.concat([wavHeader(pcm.length), pcm]));
            await run(["flac", ...FLAC_ARGS, "-o", join(to, CLICKY_PACKED_SAMPLES), joined]);
            bytes += statSync(join(to, CLICKY_PACKED_SAMPLES)).size;
        });
        log.info({ source, out, sets: ids.length, bytes }, "packed Clicky library");
        return { sets: ids.length, bytes };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

/**
 * Archives a packed library (from `packClickyLibrary`) as the release asset `out` (`.tar.gz`) and returns its pin.
 * No AppleDouble `._` files go in (`COPYFILE_DISABLE`).
 */
export async function archiveClickyLibrary(packed: string, out: string, release: string): Promise<ClickyLibraryPin> {
    await run(["tar", "--no-xattrs", "-czf", out, "-C", dirname(packed), basename(packed)], { COPYFILE_DISABLE: "1" });
    const bytes = readFileSync(out);
    const ids = setIDs(packed);
    const samples = ids.reduce(
        (sum, id) => sum + readJSON<Manifest>(join(packed, id, "manifest.json")).files.length,
        0
    );
    return {
        release,
        url: `${RELEASE_BASE}/${release}/${basename(out)}`,
        sha256: sha256(bytes),
        bytes: bytes.length,
        sets: ids.length,
        samples,
    };
}

/**
 * The packed library `pin` names, as a folder: downloaded once into `~/.genesis-tools/app/clicky-library/` and checked
 * against the pin's size and SHA-256 before it is unpacked; a later build reuses it. Throws when the download fails
 * or does not match. Only ClickyLibraryUnavailableError permits building without the library.
 */
export async function ensureClickyLibrary(
    pin: ClickyLibraryPin,
    options: {
        cacheRoot?: string;
        fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
        downloadTimeoutMs?: number;
    } = {}
): Promise<string> {
    if (
        !pin ||
        typeof pin.release !== "string" ||
        !pin.release ||
        typeof pin.url !== "string" ||
        typeof pin.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(pin.sha256) ||
        !Number.isSafeInteger(pin.bytes) ||
        pin.bytes <= 0 ||
        !Number.isSafeInteger(pin.sets) ||
        pin.sets < 0 ||
        !Number.isSafeInteger(pin.samples) ||
        pin.samples < 0
    ) {
        throw new Error("Invalid Clicky library pin");
    }

    const url = new URL(pin.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Invalid Clicky library pin URL");
    }

    const cacheRoot = options.cacheRoot ?? genesisToolsDir("app", "clicky-library");
    const target = join(cacheRoot, pin.sha256.slice(0, 16));
    const library = join(target, "ClickyLibrary");
    if (existsSync(join(library, "registry.json"))) {
        return library;
    }

    const controller = new AbortController();
    let bytes: Buffer;
    try {
        // One deadline covers headers and the whole body; expiry also cancels the transport.
        bytes = await withTimeout(
            (async () => {
                const response = await (options.fetchImpl ?? fetch)(pin.url, { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} for ${pin.url}`);
                }

                return Buffer.from(await response.arrayBuffer());
            })(),
            options.downloadTimeoutMs ?? 120_000
        );
    } catch (cause) {
        throw new ClickyLibraryUnavailableError(`Clicky library download unavailable: ${pin.url}`, { cause });
    } finally {
        controller.abort();
    }

    const digest = sha256(bytes);
    if (bytes.length !== pin.bytes || digest !== pin.sha256) {
        throw new Error(
            `${pin.url} is ${bytes.length} bytes with SHA-256 ${digest}; the pin says ${pin.bytes} and ${pin.sha256}`
        );
    }

    const staging = `${target}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
        const archive = join(staging, "library.tar.gz");
        writeFileSync(archive, bytes);
        await run(["tar", "-xzf", archive, "-C", staging]);
        rmSync(archive);
        if (!existsSync(join(staging, "ClickyLibrary", "registry.json"))) {
            throw new Error(`${pin.url} holds no ClickyLibrary/registry.json`);
        }

        rmSync(target, { recursive: true, force: true });
        renameSync(staging, target);
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }

    log.info({ release: pin.release, bytes: pin.bytes, target }, "downloaded Clicky library");
    return library;
}

/**
 * Unpacks into `out` (the app bundle's `Resources/ClickyLibrary`): the metadata copied, each set's FLAC decoded with
 * macOS's own `afconvert`, cut by the manifest's frame counts, and written as canonical WAVs. Every WAV is checked
 * against the manifest's SHA-256, so a build fails rather than ship a sample that differs from the original.
 */
export async function unpackClickyLibrary(source: string, out: string): Promise<{ sets: number; samples: number }> {
    if (!existsSync(join(source, "registry.json"))) {
        throw new Error(`no Clicky library at ${source}`);
    }

    mkdirSync(out, { recursive: true });
    cpSync(source, out, { recursive: true, filter: (path) => basename(path) !== CLICKY_PACKED_SAMPLES });
    const scratch = mkdtempSync(join(tmpdir(), "gt-clicky-unpack-"));
    let samples = 0;
    try {
        const ids = setIDs(source);
        await eachSet(ids, async (id) => {
            const manifest = readJSON<Manifest>(join(source, id, "manifest.json"));
            const decoded = join(scratch, `${id}.wav`);
            await run(["afconvert", "-f", "WAVE", "-d", "LEI16", join(source, id, CLICKY_PACKED_SAMPLES), decoded]);
            const pcm = wavPCM(readFileSync(decoded), `${id}/${CLICKY_PACKED_SAMPLES}`);
            const expected = manifest.files.reduce((sum, file) => sum + file.frames * 2, 0);
            if (pcm.length !== expected) {
                throw new Error(`${id}: ${pcm.length / 2} decoded frames, the manifest says ${expected / 2}`);
            }

            let offset = 0;
            for (const file of manifest.files) {
                const part = pcm.subarray(offset, offset + file.frames * 2);
                offset += file.frames * 2;
                const wav = Buffer.concat([wavHeader(part.length), part]);
                if (sha256(wav) !== file.sha256.toLowerCase()) {
                    throw new Error(`${id}/${file.filename}: the decoded sample does not match the manifest's SHA-256`);
                }

                writeFileSync(join(out, id, file.filename), wav);
                samples++;
            }
        });
        log.debug({ source, out, sets: ids.length, samples }, "unpacked Clicky library");
        return { sets: ids.length, samples };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const [verb, source, out, release] = process.argv.slice(2);
    const usage =
        "usage: bun src/macos/lib/clicky-library.ts pack|unpack <source> <out> | archive <packed> <out.tar.gz> <release>\n";
    if (!["pack", "unpack", "archive"].includes(verb ?? "") || !source || !out || (verb === "archive" && !release)) {
        process.stderr.write(usage);
        process.exit(1);
    }

    const result =
        verb === "pack"
            ? await packClickyLibrary(source, out)
            : verb === "archive"
              ? await archiveClickyLibrary(source, out, release)
              : await unpackClickyLibrary(source, out);
    process.stdout.write(`${SafeJSON.stringify(result, null, 2)}\n`);
}
