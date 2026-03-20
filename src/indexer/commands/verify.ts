import { formatBytes } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerVerifyCommand(program: Command): void {
    program
        .command("verify")
        .description("Check index consistency and report problems")
        .argument("[name]", "Index name (verifies all if omitted)")
        .action(async (name?: string) => {
            p.intro(pc.bgCyan(pc.white(" indexer verify ")));

            const { IndexerManager } = await import("../lib/manager");
            const manager = await IndexerManager.load();

            try {
                const names = name ? [name] : manager.getIndexNames();

                if (names.length === 0) {
                    p.log.info("No indexes found");
                    p.outro("Done");
                    return;
                }

                for (const indexName of names) {
                    const indexer = await manager.getIndex(indexName);
                    const info = indexer.getConsistencyInfo();

                    p.log.info(`${pc.bold(indexName)}`);
                    p.log.info(`  ${pc.dim("Path hashes:")}  ${info.pathHashCount.toLocaleString()}`);
                    p.log.info(`  ${pc.dim("Content rows:")} ${info.contentCount.toLocaleString()}`);
                    p.log.info(`  ${pc.dim("Embeddings:")}   ${info.embeddingCount.toLocaleString()}`);
                    p.log.info(`  ${pc.dim("Unembedded:")}   ${info.unembeddedCount.toLocaleString()}`);
                    p.log.info(`  ${pc.dim("DB size:")}      ${formatBytes(info.dbSizeBytes)}`);

                    const issues: string[] = [];

                    if (info.integrityCheck !== "ok") {
                        issues.push(`SQLite integrity check failed: ${info.integrityCheck}`);
                    }

                    if (info.pathHashCount === 0 && info.contentCount > 0) {
                        issues.push(
                            `Path hashes empty but ${info.contentCount.toLocaleString()} content rows exist — ` +
                                "index tracking was lost. Run --rebuild to fix"
                        );
                    } else if (info.pathHashCount > 0 && info.contentCount > info.pathHashCount * 3) {
                        issues.push(
                            `Content rows (${info.contentCount.toLocaleString()}) far exceed path hashes (${info.pathHashCount.toLocaleString()}) — ` +
                                "likely orphaned chunks from a previous crash"
                        );
                    }

                    if (info.embeddingCount > info.contentCount) {
                        issues.push(
                            `More embeddings (${info.embeddingCount.toLocaleString()}) than content rows (${info.contentCount.toLocaleString()}) — ` +
                                "orphaned embeddings exist"
                        );
                    }

                    if (info.unembeddedCount > 0 && info.embeddingCount > 0) {
                        const pct = Math.round((info.unembeddedCount / info.contentCount) * 100);
                        issues.push(
                            `${info.unembeddedCount.toLocaleString()} chunks (${pct}%) have no embedding — run sync to generate`
                        );
                    }

                    if (issues.length === 0) {
                        p.log.success("  No issues found");
                    } else {
                        for (const issue of issues) {
                            p.log.warn(`  ${pc.yellow("!")} ${issue}`);
                        }
                    }

                    await indexer.close();
                }
            } finally {
                await manager.close();
            }

            p.outro("Done");
        });
}
