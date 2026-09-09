import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { NativeSessionSource } from "./types";

export function sourceFingerprint(options: {
    source: NativeSessionSource<string>;
    parserVersion: string;
    fullMetadataSnapshot?: boolean;
    statisticsSnapshot?: boolean;
}): string {
    const { source } = options;
    const hash = createHash("sha256")
        .update(options.parserVersion)
        .update(source.metadataFingerprint ?? "");
    const paths = new Set([
        source.filePath,
        ...source.dataPaths,
        ...(options.fullMetadataSnapshot || source.metadataFingerprint === undefined ? source.metadataPaths : []),
        ...(options.statisticsSnapshot ? (source.statisticsPaths ?? []) : []),
    ]);

    for (const path of [...paths].sort()) {
        try {
            const value = statSync(path, { bigint: true });
            hash.update(`${path}:${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}\n`);
        } catch (error) {
            if (
                options.statisticsSnapshot &&
                source.statisticsPaths?.includes(path) &&
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
            ) {
                hash.update(`${path}:absent\n`);
            } else {
                throw error;
            }
        }
    }

    return hash.digest("hex");
}
