import { isInteractive } from "@app/utils/cli";
import { formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { IndexerManager } from "../lib/manager";
import { createProgressCallbacks } from "../lib/progress";

export function registerRebuildCommand(program: Command): void {
    program
        .command("rebuild")
        .description("Full reindex — re-scans source files and re-chunks (does NOT change vector driver; use migrate-vec for that)")
        .argument("[name]", "Index name")
        .action(async (name?: string) => {
            const manager = await IndexerManager.load();

            try {
                let targetName = name;

                if (!targetName) {
                    const names = manager.getIndexNames();

                    if (names.length === 0) {
                        p.log.info("No indexes configured. Run: tools indexer add <path>");
                        return;
                    }

                    if (isInteractive()) {
                        const selected = await p.select({
                            message: "Select index to rebuild",
                            options: names.map((n) => ({ value: n, label: n })),
                        });

                        if (p.isCancel(selected)) {
                            p.log.info("Cancelled");
                            return;
                        }

                        targetName = selected;
                    } else {
                        p.log.error("Index name required in non-interactive mode");
                        process.exit(1);
                    }
                }

                p.intro(pc.bgCyan(pc.white(` rebuild ${targetName} `)));

                if (isInteractive()) {
                    const confirmed = await p.confirm({
                        message: `Rebuild "${targetName}"? This will re-scan all source files and re-chunk.`,
                    });

                    if (p.isCancel(confirmed) || !confirmed) {
                        p.log.info("Cancelled");
                        return;
                    }
                }

                const spinner = p.spinner();
                spinner.start("Rebuilding index...");

                const stats = await manager.rebuildIndex(targetName, createProgressCallbacks(spinner));

                spinner.stop("Rebuild complete");

                p.log.success(
                    `${pc.bold(String(stats.filesScanned))} files scanned, ` +
                        `${pc.bold(String(stats.chunksAdded + stats.chunksUpdated))} chunks indexed ` +
                        `in ${formatDuration(stats.durationMs)}`
                );

                p.outro("Done");
            } finally {
                await manager.close();
            }
        });
}
