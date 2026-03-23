import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { concurrentMap } from "@app/utils/async";
import ignore, { type Ignore } from "ignore";
import {
    type DetectChangesOptions,
    defaultDetectChanges,
    defaultHashEntry,
    type IndexerSource,
    type ScanOptions,
    type SourceChanges,
    type SourceEntry,
} from "./source";

export interface FileSourceOptions {
    baseDir: string;
    respectGitIgnore?: boolean;
    includedSuffixes?: string[];
    ignoredPaths?: string[];
}

export class FileSource implements IndexerSource {
    private opts: FileSourceOptions;
    private absBaseDir: string;
    private ignoreFilter: Ignore | null = null;

    constructor(opts: FileSourceOptions) {
        this.opts = opts;
        this.absBaseDir = resolve(opts.baseDir);
        this.ignoreFilter = this.loadIgnoreFile();
    }

    async scan(scanOpts?: ScanOptions): Promise<SourceEntry[]> {
        let filePaths = await this.getFilteredFilePaths();

        if (scanOpts?.limit) {
            filePaths = filePaths.slice(0, scanOpts.limit);
        }

        const total = filePaths.length;
        const batchSize = scanOpts?.batchSize ?? 500;

        const readResults = await concurrentMap({
            items: filePaths,
            fn: async (filePath) => {
                const content = await Bun.file(filePath).text();
                return { id: filePath, content, path: filePath } as SourceEntry;
            },
            concurrency: 50,
        });

        const entries: SourceEntry[] = [];
        let batch: SourceEntry[] = [];

        for (const [, entry] of readResults) {
            entries.push(entry);
            batch.push(entry);

            if (scanOpts?.onBatch && batch.length >= batchSize) {
                await scanOpts.onBatch(batch);
                batch = [];
            }

            if (scanOpts?.onProgress) {
                scanOpts.onProgress(entries.length, total);
            }
        }

        if (scanOpts?.onBatch && batch.length > 0) {
            await scanOpts.onBatch(batch);
        }

        return entries;
    }

    detectChanges(opts: DetectChangesOptions): SourceChanges {
        return defaultDetectChanges(opts, this.hashEntry.bind(this));
    }

    hashEntry(entry: SourceEntry): string {
        return defaultHashEntry(entry);
    }

    async estimateTotal(): Promise<number> {
        const filePaths = await this.getFilteredFilePaths();
        return filePaths.length;
    }

    private async getFilteredFilePaths(): Promise<string[]> {
        let filePaths: string[];

        if (this.opts.respectGitIgnore) {
            const isGit = await this.checkIsGitRepo();
            filePaths = isGit ? await this.getGitTrackedFiles() : this.walkDirectory();
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

        if (this.ignoreFilter) {
            filePaths = filePaths.filter((f) => !this.isIgnoredByFilter(f));
        }

        return filePaths;
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

    private loadIgnoreFile(): Ignore | null {
        const ignorePath = join(this.absBaseDir, ".genesistoolsignore");

        if (!existsSync(ignorePath)) {
            return null;
        }

        const content = readFileSync(ignorePath, "utf-8");
        return ignore().add(content);
    }

    private isIgnoredByFilter(absolutePath: string): boolean {
        if (!this.ignoreFilter) {
            return false;
        }

        const rel = relative(this.absBaseDir, absolutePath);
        return this.ignoreFilter.ignores(rel);
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
