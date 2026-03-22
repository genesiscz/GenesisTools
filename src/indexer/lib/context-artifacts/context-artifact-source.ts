import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
    type DetectChangesOptions,
    defaultDetectChanges,
    type IndexerSource,
    type ScanOptions,
    type SourceChanges,
    type SourceEntry,
} from "../sources/source";
import { loadContextConfig } from "./config";
import type { ContextArtifact } from "./types";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

export class ContextArtifactSource implements IndexerSource {
    private projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = path.resolve(projectPath);
    }

    async scan(opts?: ScanOptions): Promise<SourceEntry[]> {
        const config = await loadContextConfig(this.projectPath);

        if (!config?.artifacts?.length) {
            return [];
        }

        const entries: SourceEntry[] = [];
        let count = 0;

        for (const artifact of config.artifacts) {
            if (opts?.limit && count >= opts.limit) {
                break;
            }

            const content = await this.readArtifactContent(artifact);
            const entry: SourceEntry = {
                id: `context::${artifact.name}`,
                content,
                path: artifact.path,
                metadata: {
                    artifactName: artifact.name,
                    artifactDescription: artifact.description,
                    type: "context-artifact",
                },
            };

            entries.push(entry);
            count++;

            if (opts?.onProgress) {
                opts.onProgress(count, config.artifacts.length);
            }
        }

        if (opts?.onBatch && entries.length > 0) {
            await opts.onBatch(entries);
        }

        return entries;
    }

    detectChanges(opts: DetectChangesOptions): SourceChanges {
        return defaultDetectChanges(opts, this.hashEntry.bind(this));
    }

    hashEntry(entry: SourceEntry): string {
        return createHash("sha256").update(entry.content).digest("hex").slice(0, 16);
    }

    async estimateTotal(): Promise<number> {
        const config = await loadContextConfig(this.projectPath);
        return config?.artifacts?.length ?? 0;
    }

    // -- Private helpers --

    private async readArtifactContent(artifact: ContextArtifact): Promise<string> {
        const resolved = path.isAbsolute(artifact.path) ? artifact.path : path.resolve(this.projectPath, artifact.path);

        const stat = await fsp.stat(resolved);

        if (stat.isFile()) {
            return fsp.readFile(resolved, "utf-8");
        }

        if (stat.isDirectory()) {
            return this.readDirectoryContent(resolved);
        }

        throw new Error(`Artifact "${artifact.name}": path is neither file nor directory: ${resolved}`);
    }

    private async readDirectoryContent(dirPath: string): Promise<string> {
        const files = await this.collectFiles(dirPath, "");
        files.sort();

        const parts: string[] = [];

        for (const file of files) {
            const filePath = path.join(dirPath, file);

            try {
                const content = await fsp.readFile(filePath, "utf-8");
                parts.push(`# -- ${file} --\n${content}`);
            } catch {
                // Skip unreadable files (binary, permissions)
            }
        }

        if (parts.length === 0) {
            throw new Error(`Artifact directory contains no readable files: ${dirPath}`);
        }

        return parts.join("\n\n");
    }

    private async collectFiles(baseDir: string, relativeDir: string): Promise<string[]> {
        const result: string[] = [];
        const absDir = relativeDir ? path.join(baseDir, relativeDir) : baseDir;
        const dirents = await fsp.readdir(absDir, { withFileTypes: true });

        for (const dirent of dirents) {
            const name = String(dirent.name);

            if (SKIP_DIRS.has(name) || name.startsWith(".")) {
                continue;
            }

            const relativePath = relativeDir ? `${relativeDir}/${name}` : name;

            if (dirent.isDirectory()) {
                const nested = await this.collectFiles(baseDir, relativePath);
                result.push(...nested);
            } else if (dirent.isFile()) {
                result.push(relativePath);
            }
        }

        return result;
    }
}
