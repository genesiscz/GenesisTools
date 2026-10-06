import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { RECAST_LIMITS, type RecastDocument, readRecastDocument } from "./document";

export async function readRecastInput(inputPath: string): Promise<{ document: RecastDocument; packagePath?: string }> {
    const info = await lstat(inputPath);
    const packagePath = info.isDirectory() ? inputPath : undefined;
    const manifestPath = packagePath ? join(packagePath, "manifest.json") : inputPath;
    const manifestInfo = await lstat(manifestPath);

    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > RECAST_LIMITS.manifestBytes) {
        throw new Error("Choose a regular Recast manifest no larger than 32 MiB.");
    }

    logger.debug({ manifestPath, bytes: manifestInfo.size }, "recast: reading conversion");
    const text = await readFile(manifestPath, "utf8");
    if (Buffer.byteLength(text) > RECAST_LIMITS.manifestBytes) {
        throw new Error("The manifest grew beyond the size limit while reading.");
    }
    return { document: readRecastDocument(SafeJSON.parse(text, { strict: true })), packagePath };
}

export async function verifyRecastAssets({
    document,
    packagePath,
    signal,
}: {
    document: RecastDocument;
    packagePath: string;
    signal?: AbortSignal;
}): Promise<void> {
    const directory = join(packagePath, "sources");
    if (document.sources.length === 0) {
        return;
    }
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
        throw new Error("The source snapshot directory must be an ordinary package directory.");
    }

    for (const source of document.sources) {
        signal?.throwIfAborted();
        const assetPath = join(directory, source.assetName);
        const info = await lstat(assetPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== source.bytes) {
            throw new Error(`A source snapshot is missing or changed: ${source.name}`);
        }

        logger.debug({ assetPath, bytes: source.bytes }, "recast: verifying source snapshot");
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of Bun.file(assetPath).stream()) {
            signal?.throwIfAborted();
            bytes += chunk.byteLength;
            if (bytes > source.bytes) {
                throw new Error(`A source snapshot changed during verification: ${source.name}`);
            }
            hash.update(chunk);
        }
        if (source.kind === "text") {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(assetPath));
            if (text.length !== source.textLength) {
                throw new Error("The source text length does not match its snapshot metadata.");
            }
            for (const anchor of document.anchors) {
                if (anchor.sourceId === source.id && anchor.region.kind === "text") {
                    const region = anchor.region;
                    if (
                        text.slice(region.start, region.end) !== region.quote ||
                        (region.prefix && !text.slice(0, region.start).endsWith(region.prefix)) ||
                        (region.suffix && !text.slice(region.end).startsWith(region.suffix))
                    ) {
                        throw new Error("A literal text region does not match the preserved source.");
                    }
                }
            }
        }
        if (bytes !== source.bytes || hash.digest("hex") !== source.contentHash) {
            throw new Error(`A source snapshot hash no longer matches its evidence: ${source.name}`);
        }
    }
}
