import type { Dirent } from "node:fs";
import { readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { DetectChangesOptions, IndexerSource, ScanOptions, SourceChanges, SourceEntry } from "./source";

export interface FileSourceOptions {
    baseDir: string;
    respectGitIgnore?: boolean;
    includedSuffixes?: string[];
    ignoredPaths?: string[];
}

export class FileSource implements IndexerSource {
    private opts: FileSourceOptions;
    private absBaseDir: string;

    constructor(opts: FileSourceOptions) {
        this.opts = opts;
        this.absBaseDir = resolve(opts.baseDir);
    }

    async scan(scanOpts?: ScanOptions): Promise<SourceEntry[]> {
        let filePaths: string[];

        if (this.opts.respectGitIgnore) {
            const isGit = await this.checkIsGitRepo();

            if (isGit) {
                filePaths = await this.getGitTrackedFiles();
            } else {
                filePaths = this.walkDirectory();
            }
        } else {
            filePaths = this.walkDirectory();
        }

        if (this.opts.includedSuffixes && this.opts.includedSuffixes.length > 0) {
            const suffixSet = new Set(this.opts.includedSuffixes.map((s) => (s.startsWith(".") ? s : `.${s}`)));
            filePaths = filePaths.filter((f) => suffixSet.has(extname(f).toLowerCase()));
        }

        if (this.opts.ignoredPaths && this.opts.ignoredPaths.length > 0) {
            const ignored = this.opts.ignoredPaths;
            filePaths = filePaths.filter((f) => {
                const rel = relative(this.absBaseDir, f);
                return !ignored.some((pattern) => rel.startsWith(pattern) || rel.includes(pattern));
            });
        }

        if (scanOpts?.limit) {
            filePaths = filePaths.slice(0, scanOpts.limit);
        }

        const entries: SourceEntry[] = [];
        const total = filePaths.length;
        const batchSize = scanOpts?.batchSize ?? 500;
        let batch: SourceEntry[] = [];

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];

            try {
                const content = await Bun.file(filePath).text();
                const entry: SourceEntry = {
                    id: filePath,
                    content,
                    path: filePath,
                };

                entries.push(entry);
                batch.push(entry);
            } catch {
                // Skip unreadable files
            }

            if (scanOpts?.onBatch && batch.length >= batchSize) {
                await scanOpts.onBatch(batch);
                batch = [];
            }

            if (scanOpts?.onProgress) {
                scanOpts.onProgress(i + 1, total);
            }
        }

        if (scanOpts?.onBatch && batch.length > 0) {
            await scanOpts.onBatch(batch);
        }

        return entries;
    }

    detectChanges(opts: DetectChangesOptions): SourceChanges {
        const { previousHashes, currentEntries, full } = opts;

        if (full || !previousHashes) {
            return {
                added: currentEntries,
                modified: [],
                deleted: [],
                unchanged: [],
            };
        }

        const added: SourceEntry[] = [];
        const modified: SourceEntry[] = [];
        const unchanged: string[] = [];
        const currentPaths = new Set<string>();

        for (const entry of currentEntries) {
            const rel = relative(this.absBaseDir, entry.id);
            currentPaths.add(rel);
            const currentHash = this.hashEntry(entry);
            const previousHash = previousHashes.get(rel);

            if (!previousHash) {
                added.push(entry);
            } else if (previousHash !== currentHash) {
                modified.push(entry);
            } else {
                unchanged.push(rel);
            }
        }

        const deleted: string[] = [];

        for (const prevPath of previousHashes.keys()) {
            if (!currentPaths.has(prevPath)) {
                deleted.push(prevPath);
            }
        }

        return { added, modified, deleted, unchanged };
    }

    hashEntry(entry: SourceEntry): string {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(entry.content);
        return hasher.digest("hex");
    }

    async estimateTotal(): Promise<number> {
        let filePaths: string[];

        if (this.opts.respectGitIgnore) {
            const isGit = await this.checkIsGitRepo();

            if (isGit) {
                filePaths = await this.getGitTrackedFiles();
            } else {
                filePaths = this.walkDirectory();
            }
        } else {
            filePaths = this.walkDirectory();
        }

        if (this.opts.includedSuffixes && this.opts.includedSuffixes.length > 0) {
            const suffixSet = new Set(this.opts.includedSuffixes.map((s) => (s.startsWith(".") ? s : `.${s}`)));
            filePaths = filePaths.filter((f) => suffixSet.has(extname(f).toLowerCase()));
        }

        return filePaths.length;
    }

    private async checkIsGitRepo(): Promise<boolean> {
        const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
            cwd: this.absBaseDir,
            stdout: "pipe",
            stderr: "pipe",
        });
        await proc.exited;
        return proc.exitCode === 0;
    }

    private async getGitTrackedFiles(): Promise<string[]> {
        const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
            cwd: this.absBaseDir,
            stdout: "pipe",
            stderr: "pipe",
        });

        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        return stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((rel) => join(this.absBaseDir, rel));
    }

    private walkDirectory(): string[] {
        const result: string[] = [];

        const walk = (dir: string): void => {
            let entries: Dirent[];

            try {
                entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
            } catch {
                return;
            }

            for (const entry of entries) {
                const name = String(entry.name);
                const fullPath = join(dir, name);

                if (entry.isDirectory()) {
                    if (name.startsWith(".") || name === "node_modules") {
                        continue;
                    }

                    walk(fullPath);
                } else if (entry.isFile()) {
                    result.push(fullPath);
                }
            }
        };

        walk(this.absBaseDir);
        return result;
    }
}
