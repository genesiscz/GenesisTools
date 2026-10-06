import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { ArtifactRef } from "../../descriptors/types";
import type { CachedArtifact } from "../types";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_ENTRIES = 4096;
const ARCHIVE_LIST_OUTPUT_BYTES = 2 * 1024 * 1024;
const ARCHIVE_ERROR_OUTPUT_BYTES = 64 * 1024;
const ARCHIVE_TIMEOUT_MS = 120_000;

/** Injectable so tests can exercise download/extract without network. */
export type ArtifactFetcher = (url: string) => Promise<ArrayBuffer | Response>;

export interface UrlSourceOptions {
    fetcher?: ArtifactFetcher;
    maxDownloadBytes?: number;
    maxArchiveExpandedBytes?: number;
    maxArchiveEntries?: number;
}

/**
 * Fetch a model asset with a hard timeout so a hung connection fails fast
 * (the caller degrades to transcript-without-speakers) instead of blocking
 * the CLI forever.
 */
export const fetchArtifact: ArtifactFetcher = async (url: string): Promise<Response> => {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

        if (!res.ok) {
            throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
        }

        return res;
    } catch (error) {
        if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
            throw new Error(`Failed to download ${url}: timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
        }

        throw error;
    }
};

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel();
                throw new Error(`tar output exceeds ${maxBytes} bytes`);
            }
            output += decoder.decode(value, { stream: true });
        }
        return output + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

async function runTar(args: string[], timeoutMs = ARCHIVE_TIMEOUT_MS): Promise<string> {
    const proc = Bun.spawn(["tar", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(timeoutMs),
    });
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
        [stdout, stderr, exitCode] = await Promise.all([
            readBoundedStream(proc.stdout, ARCHIVE_LIST_OUTPUT_BYTES),
            readBoundedStream(proc.stderr, ARCHIVE_ERROR_OUTPUT_BYTES),
            proc.exited,
        ]);
    } catch (error) {
        proc.kill();
        await proc.exited;
        throw error;
    }
    if (exitCode !== 0) {
        throw new Error(`tar ${args[0]} failed: ${stderr.slice(0, 400)}`);
    }

    return stdout;
}

async function expandedBytes(root: string, maxBytes: number): Promise<number> {
    let total = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) {
            throw new Error(`archive contains a symbolic link: ${entry.name}`);
        }
        if (stats.isDirectory()) {
            total += await expandedBytes(path, maxBytes - total);
        } else if (stats.isFile()) {
            total += stats.size;
        } else {
            throw new Error(`archive contains unsupported entry type: ${entry.name}`);
        }
        if (total > maxBytes) {
            throw new Error(`archive expanded size exceeds ${maxBytes} bytes`);
        }
    }

    return total;
}

async function writeFully(file: FileHandle, chunk: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) {
            throw new Error("artifact staging write made no progress");
        }
        offset += bytesWritten;
    }
}

export function parseTarVerboseListing(listing: string, maxExpandedBytes: number): number {
    let total = 0;
    for (const line of listing.split("\n").filter(Boolean)) {
        const fields = line.trim().split(/\s+/);
        const entryType = fields[0]?.[0];
        const isGnu = fields[1]?.includes("/");
        const size = Number(fields[isGnu ? 2 : 4]);
        if ((entryType !== "-" && entryType !== "d") || !Number.isFinite(size)) {
            throw new Error("archive contains a link or unsupported entry");
        }
        total += size;
        if (total > maxExpandedBytes) {
            throw new Error(`archive expanded size exceeds ${maxExpandedBytes} bytes`);
        }
    }

    return total;
}

function fileList(root: string, dir: string, out: CachedArtifact[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
            fileList(root, fullPath, out);
            continue;
        }

        const stats = statSync(fullPath);
        out.push({
            id: relative(root, fullPath).split(sep).join("/"),
            source: "url",
            root,
            path: fullPath,
            sizeBytes: stats.size,
            mtimeMs: stats.mtimeMs,
        });
    }
}

/**
 * Direct-URL weights: the sherpa-onnx diarization models, which are ungated
 * GitHub release assets with no auth and (upstream's choice) no published
 * checksums. `sha256` on a ref is verified when present and skipped when not,
 * so a future publisher can turn verification on per artifact.
 */
export class UrlSource {
    private readonly fetcher: ArtifactFetcher;
    private readonly maxDownloadBytes: number;
    private readonly maxArchiveExpandedBytes: number;
    private readonly maxArchiveEntries: number;

    constructor(fetcherOrOptions: ArtifactFetcher | UrlSourceOptions = fetchArtifact) {
        const options = typeof fetcherOrOptions === "function" ? { fetcher: fetcherOrOptions } : fetcherOrOptions;
        this.fetcher = options.fetcher ?? fetchArtifact;
        this.maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
        this.maxArchiveExpandedBytes = options.maxArchiveExpandedBytes ?? DEFAULT_MAX_ARCHIVE_EXPANDED_BYTES;
        this.maxArchiveEntries = options.maxArchiveEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES;
    }

    /**
     * Download `ref` to `ref.file` unless it is already there. Tarballs unpack
     * into `ref.archiveRoot`; `ref.file` is then the path the archive is
     * expected to yield, and a miss is an error rather than a silent success.
     */
    async ensure(ref: ArtifactRef): Promise<{ path: string; cached: boolean }> {
        if (!ref.file) {
            throw new Error(`url artifact ${ref.locator} has no target file path`);
        }

        if (existsSync(ref.file)) {
            return { path: ref.file, cached: true };
        }

        const targetDir = ref.archive ? (ref.archiveRoot ?? dirname(ref.file)) : dirname(ref.file);
        const stageParent = ref.archive ? dirname(targetDir) : targetDir;
        await mkdir(stageParent, { recursive: true });
        const stagedFile = join(stageParent, `.${basename(ref.file)}.download-${randomUUID()}`);

        try {
            const digest = await this.downloadToStage(ref.locator, stagedFile);
            this.verify(ref, digest);

            if (ref.archive === "tar.bz2") {
                await this.extractTarBz2(ref, stagedFile, targetDir, ref.file);
                await unlink(stagedFile);
            } else {
                await rename(stagedFile, ref.file);
            }
        } catch (error) {
            await unlink(stagedFile).catch(() => undefined);
            throw error;
        }

        if (!existsSync(ref.file)) {
            throw new Error(`Artifact missing after download (layout may have changed): ${ref.file}`);
        }

        return { path: ref.file, cached: false };
    }

    list(root: string): CachedArtifact[] {
        if (!existsSync(root)) {
            return [];
        }

        const artifacts: CachedArtifact[] = [];
        fileList(root, root, artifacts);

        return artifacts;
    }

    private verify(ref: ArtifactRef, actual: string): void {
        if (!ref.sha256) {
            return;
        }

        if (actual !== ref.sha256) {
            throw new Error(`Checksum mismatch for ${ref.locator}: expected ${ref.sha256}, got ${actual}`);
        }
    }

    private async downloadToStage(locator: string, stagedFile: string): Promise<string> {
        const result = await this.fetcher(locator);
        const hasher = createHash("sha256");
        const file = await open(stagedFile, "wx", 0o600);
        let bytes = 0;

        try {
            if (result instanceof ArrayBuffer) {
                bytes = result.byteLength;
                if (bytes > this.maxDownloadBytes) {
                    throw new Error(`Artifact ${locator} exceeds ${this.maxDownloadBytes} bytes`);
                }
                const chunk = new Uint8Array(result);
                hasher.update(chunk);
                await writeFully(file, chunk);
            } else {
                if (!result.ok) {
                    throw new Error(`Failed to download ${locator}: HTTP ${result.status}`);
                }
                const declared = Number(result.headers.get("content-length"));
                if (Number.isFinite(declared) && declared > this.maxDownloadBytes) {
                    await result.body?.cancel();
                    throw new Error(`Artifact ${locator} exceeds ${this.maxDownloadBytes} bytes`);
                }
                const reader = result.body?.getReader();
                if (!reader) {
                    throw new Error(`Artifact ${locator} returned no body`);
                }
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }
                        bytes += value.byteLength;
                        if (bytes > this.maxDownloadBytes) {
                            await reader.cancel();
                            throw new Error(`Artifact ${locator} exceeds ${this.maxDownloadBytes} bytes`);
                        }
                        hasher.update(value);
                        await writeFully(file, value);
                    }
                } finally {
                    reader.releaseLock();
                }
            }
        } finally {
            await file.close();
        }

        return hasher.digest("hex");
    }

    private async extractTarBz2(
        ref: ArtifactRef,
        archivePath: string,
        targetDir: string,
        targetFile: string
    ): Promise<void> {
        const names = (await runTar(["tjf", archivePath]))
            .split("\n")
            .map((name) => name.trim())
            .filter(Boolean);
        if (names.length === 0 || names.length > this.maxArchiveEntries) {
            throw new Error(`archive entry count exceeds ${this.maxArchiveEntries}`);
        }
        if (names.some((name) => name.startsWith("/") || name.split("/").includes(".."))) {
            throw new Error("archive contains an unsafe path");
        }

        const topLevels = new Set(names.map((name) => name.split("/")[0]).filter(Boolean));
        if (topLevels.size !== 1) {
            throw new Error("archive must contain exactly one top-level directory");
        }

        parseTarVerboseListing(await runTar(["tvjf", archivePath]), this.maxArchiveExpandedBytes);

        const stageDir = join(dirname(targetDir), `.${basename(targetDir)}.extract-${randomUUID()}`);
        await mkdir(stageDir, { recursive: true });
        try {
            await runTar(["xjf", archivePath, "-C", stageDir]);
            await expandedBytes(stageDir, this.maxArchiveExpandedBytes);
            const expectedRelative = relative(targetDir, targetFile);
            if (expectedRelative.startsWith("..") || !existsSync(join(stageDir, expectedRelative))) {
                throw new Error(`Artifact missing after download (layout may have changed): ${targetFile}`);
            }

            const topLevel = [...topLevels][0] as string;
            const finalTopLevel = join(targetDir, topLevel);
            if (existsSync(finalTopLevel)) {
                throw new Error(`Refusing to overwrite existing artifact directory: ${finalTopLevel}`);
            }
            await mkdir(targetDir, { recursive: true });
            await rename(join(stageDir, topLevel), finalTopLevel);
            await rmdir(stageDir);
        } catch (error) {
            await rm(stageDir, { recursive: true, force: true });
            logger.warn({ locator: ref.locator, error }, "[artifacts:url] extraction failed");
            throw error;
        }
    }
}
