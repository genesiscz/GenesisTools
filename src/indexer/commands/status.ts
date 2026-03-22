import { formatBytes, formatDuration, formatRelativeTime } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { IndexerManager } from "../lib/manager";
import { DEFAULT_WATCH_INTERVAL_MS } from "../lib/types";

export function registerStatusCommand(program: Command): void {
    program
        .command("status")
        .description("Show index status")
        .argument("[name]", "Index name (omit for overview)")
        .action(async (name?: string) => {
            const manager = await IndexerManager.load();

            try {
                if (name) {
                    await showDetailedStatus(manager, name);
                } else {
                    showOverview(manager);
                }
            } finally {
                await manager.close();
            }
        });
}

function showOverview(manager: IndexerManager): void {
    const indexes = manager.listIndexes();

    if (indexes.length === 0) {
        p.log.info("No indexes configured. Run: tools indexer add <path>");
        return;
    }

    const headers = ["Name", "Type", "Files", "Chunks", "Embeddings", "Status", "Last Sync", "DB Size"];

    const rows = indexes.map((meta) => {
        const lastSync = meta.lastSyncAt ? formatRelativeTime(new Date(meta.lastSyncAt), { compact: true }) : "never";

        return [
            meta.name,
            meta.config.type ?? "auto",
            String(meta.stats.totalFiles),
            String(meta.stats.totalChunks),
            String(meta.stats.totalEmbeddings),
            formatIndexingStatus(meta.indexingStatus),
            lastSync,
            formatBytes(meta.stats.dbSizeBytes),
        ];
    });

    console.log("");
    console.log(formatTable(rows, headers, { alignRight: [2, 3, 4, 7] }));
    console.log("");
}

async function showDetailedStatus(manager: IndexerManager, name: string): Promise<void> {
    const indexes = manager.listIndexes();
    const meta = indexes.find((m) => m.name === name);

    if (!meta) {
        p.log.error(`Index "${name}" not found`);
        process.exit(1);
    }

    p.intro(pc.bgCyan(pc.white(` ${meta.name} `)));

    const entries: Array<[string, string]> = [
        ["Base Dir", meta.config.baseDir],
        ["Type", meta.config.type ?? "auto"],
        ["Status", formatIndexingStatus(meta.indexingStatus)],
        ["Chunking", meta.config.chunking ?? "auto"],
        ["Git Ignore", String(meta.config.respectGitIgnore ?? false)],
        ["Files", String(meta.stats.totalFiles)],
        ["Chunks", String(meta.stats.totalChunks)],
        ["Embeddings", String(meta.stats.totalEmbeddings)],
        ["Embedding Dims", String(meta.stats.embeddingDimensions)],
        ["DB Size", formatBytes(meta.stats.dbSizeBytes)],
        [
            "Last Sync",
            meta.lastSyncAt
                ? `${formatRelativeTime(new Date(meta.lastSyncAt))} (${formatDuration(meta.stats.lastSyncDurationMs)})`
                : "never",
        ],
        ["Searches", String(meta.stats.searchCount)],
        ["Avg Search", meta.stats.avgSearchDurationMs > 0 ? formatDuration(meta.stats.avgSearchDurationMs) : "n/a"],
        ["Created", meta.createdAt > 0 ? formatRelativeTime(new Date(meta.createdAt)) : "unknown"],
    ];

    if (meta.config.ignoredPaths && meta.config.ignoredPaths.length > 0) {
        entries.push(["Ignored", meta.config.ignoredPaths.join(", ")]);
    }

    if (meta.config.includedSuffixes && meta.config.includedSuffixes.length > 0) {
        entries.push(["Included", meta.config.includedSuffixes.join(", ")]);
    }

    if (meta.config.watch?.enabled) {
        entries.push([
            "Watch",
            `${meta.config.watch.strategy ?? "merkle"} (${meta.config.watch.interval ?? DEFAULT_WATCH_INTERVAL_MS}ms)`,
        ]);
    }

    for (const [label, value] of entries) {
        p.log.step(`${pc.bold(label)}: ${value}`);
    }

    if (meta.indexingStatus === "in-progress" || meta.indexingStatus === "cancelled") {
        p.log.warn(`This index was interrupted. Run: tools indexer sync ${name} to resume.`);
    }

    p.outro("");
}

function formatIndexingStatus(status: string | undefined): string {
    switch (status) {
        case "in-progress":
            return pc.yellow("in-progress");
        case "completed":
            return pc.green("completed");
        case "cancelled":
            return pc.red("cancelled");
        case "idle":
            return pc.dim("idle");
        default:
            return pc.dim("idle");
    }
}
