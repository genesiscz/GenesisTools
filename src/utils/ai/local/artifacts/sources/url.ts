import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { ArtifactRef } from "../../descriptors/types";
import type { CachedArtifact } from "../types";

const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Injectable so tests can exercise download/extract without network. */
export type ArtifactFetcher = (url: string) => Promise<ArrayBuffer>;

/**
 * Fetch a model asset with a hard timeout so a hung connection fails fast
 * (the caller degrades to transcript-without-speakers) instead of blocking
 * the CLI forever.
 */
export const fetchArtifact: ArtifactFetcher = async (url: string): Promise<ArrayBuffer> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok) {
            throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
        }

        return await res.arrayBuffer();
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error(`Failed to download ${url}: timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
};

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
    constructor(private readonly fetcher: ArtifactFetcher = fetchArtifact) {}

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
        await mkdir(targetDir, { recursive: true });

        const bytes = await this.fetcher(ref.locator);
        this.verify(ref, bytes);

        if (ref.archive === "tar.bz2") {
            await this.extractTarBz2(ref, bytes, targetDir);
        } else {
            await Bun.write(ref.file, bytes);
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

    private verify(ref: ArtifactRef, bytes: ArrayBuffer): void {
        if (!ref.sha256) {
            return;
        }

        const actual = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

        if (actual !== ref.sha256) {
            throw new Error(`Checksum mismatch for ${ref.locator}: expected ${ref.sha256}, got ${actual}`);
        }
    }

    private async extractTarBz2(ref: ArtifactRef, bytes: ArrayBuffer, targetDir: string): Promise<void> {
        const archivePath = join(targetDir, `${createHash("sha1").update(ref.locator).digest("hex")}.tar.bz2`);
        await Bun.write(archivePath, bytes);

        const proc = Bun.spawn(["tar", "xjf", archivePath, "-C", targetDir], { stderr: "pipe" });
        const extractFailed = (await proc.exited) !== 0;
        const stderr = extractFailed ? await new Response(proc.stderr).text() : "";
        await rm(archivePath, { force: true });

        if (extractFailed) {
            logger.warn({ locator: ref.locator, stderr }, "[artifacts:url] extraction failed");
            throw new Error(`Failed to extract ${ref.locator}: ${stderr}`);
        }
    }
}
