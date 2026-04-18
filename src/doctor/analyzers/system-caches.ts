import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { classifyCachePath } from "@app/doctor/lib/safety";
import { duBytes, formatBytes } from "@app/doctor/lib/size";
import type { Action, AnalyzerCategory, AnalyzerContext, ExecutorContext, Finding } from "@app/doctor/lib/types";
import clipboardy from "clipboardy";

interface CacheEntry {
    name: string;
    path: string;
    displayPath: string;
    bytes: number;
}

interface ArchivedLog {
    path: string;
    size: number;
    days: number;
}

export class SystemCachesAnalyzer extends Analyzer {
    readonly id = "system-caches";
    readonly name = "System Caches";
    readonly icon = "S";
    readonly category: AnalyzerCategory = "system";
    readonly cacheTtlMs = 6 * 60 * 60 * 1000;

    protected async *run(ctx: AnalyzerContext): AsyncIterable<Finding> {
        const cachesRoot = join(homedir(), "Library", "Caches");

        if (!existsSync(cachesRoot)) {
            return;
        }

        const entries = safeReadDir(cachesRoot);
        const sized: CacheEntry[] = [];
        let scanned = 0;

        for (const name of entries) {
            scanned++;
            ctx.emit({
                type: "progress",
                analyzerId: this.id,
                phase: "scanning",
                percent: entries.length === 0 ? 100 : (scanned / entries.length) * 100,
                currentItem: name,
                findingsCount: sized.length,
            });

            const path = join(cachesRoot, name);
            if (!isDirectory(path)) {
                continue;
            }

            const displayPath = `~/Library/Caches/${name}`;
            const classification = classifyCachePath(displayPath);
            const bytes = await duBytes(path);

            if (bytes < 50 * 1024 * 1024 && classification.severity !== "blocked") {
                continue;
            }

            sized.push({ name, path, displayPath, bytes });
        }

        sized.sort((left, right) => right.bytes - left.bytes);

        for (const entry of sized.slice(0, 30)) {
            yield buildSystemCacheFinding(entry);
        }

        const logs = archivedLogs("/var/log");
        if (logs.length === 0) {
            return;
        }

        const totalSize = logs.reduce((acc, log) => acc + log.size, 0);
        yield {
            id: "sys-var-log",
            analyzerId: this.id,
            title: `${logs.length} archived log(s) in /var/log older than 7 days`,
            detail: `${formatBytes(totalSize)} · requires sudo to delete`,
            severity: "cautious",
            reclaimableBytes: totalSize,
            actions: [
                {
                    id: "copy-archived-log-command",
                    label: "Copy sudo cleanup command",
                    confirm: "none",
                    execute: async (_ctx, finding) => {
                        await clipboardy.write(archivedLogCommand(logs.map((log) => log.path)));

                        return {
                            findingId: finding.id,
                            actionId: "copy-archived-log-command",
                            status: "ok",
                        };
                    },
                },
            ],
            metadata: { paths: logs.map((log) => log.path), totalSize },
        };
    }
}

export function buildSystemCacheFinding(entry: CacheEntry): Finding {
    const classification = classifyCacheEntry(entry.displayPath);
    const blocked = classification.severity === "blocked";

    return {
        id: `sys-cache-${entry.name}`,
        analyzerId: "system-caches",
        title: entry.displayPath,
        detail: `${formatBytes(entry.bytes)}${blocked ? ` · ${classification.reason ?? "blocked"}` : ""}`,
        severity: blocked ? "blocked" : "cautious",
        blacklistReason: classification.reason,
        reclaimableBytes: blocked ? undefined : entry.bytes,
        actions: blocked ? [] : [deleteCacheAction(entry.path, entry.bytes)],
        metadata: { path: entry.path, bytes: entry.bytes },
    };
}

function classifyCacheEntry(displayPath: string): ReturnType<typeof classifyCachePath> {
    const direct = classifyCachePath(displayPath);

    if (direct.severity === "blocked") {
        return direct;
    }

    return classifyCachePath(`${displayPath}/`);
}

export function archivedLogCommand(paths: string[]): string {
    return [
        "# Execute this plox because deleting archived system logs requires sudo",
        `sudo /bin/rm -- ${paths.map(shellQuote).join(" ")}`,
    ].join("\n");
}

function deleteCacheAction(path: string, bytes: number): Action {
    return {
        id: "delete-cache",
        label: "Delete cache",
        confirm: "yesno",
        execute: async (_ctx: ExecutorContext, finding) => {
            try {
                await rm(path, { recursive: true, force: true });

                return {
                    findingId: finding.id,
                    actionId: "delete-cache",
                    status: "ok",
                    actualReclaimedBytes: bytes,
                    metadata: { path },
                };
            } catch (err) {
                return {
                    findingId: finding.id,
                    actionId: "delete-cache",
                    status: "failed",
                    error: err instanceof Error ? err.message : "Failed to delete cache",
                    metadata: { path },
                };
            }
        },
    };
}

function archivedLogs(root: string): ArchivedLog[] {
    if (!existsSync(root)) {
        return [];
    }

    return safeReadDir(root)
        .filter((name) => /\.gz$|\.asl$|\.bz2$/.test(name))
        .map((name) => archivedLog(root, name))
        .filter((entry): entry is ArchivedLog => entry !== null && entry.days > 7);
}

function archivedLog(root: string, name: string): ArchivedLog | null {
    try {
        const path = join(root, name);
        const stat = statSync(path);

        if (!stat.isFile()) {
            return null;
        }

        return {
            path,
            size: stat.size,
            days: (Date.now() - stat.mtime.getTime()) / (86400 * 1000),
        };
    } catch {
        return null;
    }
}

function safeReadDir(path: string): string[] {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
