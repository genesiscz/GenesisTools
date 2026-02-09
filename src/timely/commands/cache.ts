import logger from "@app/logger";
import type { Storage } from "@app/utils/storage";
import { ExitPromptError } from "@inquirer/core";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";

export function registerCacheCommand(program: Command, storage: Storage): void {
    const cacheCmd = program.command("cache").description("Manage cache");

    cacheCmd
        .command("list")
        .description("List all cached files")
        .option("-f, --format <format>", "Output format: json, table", "table")
        .action(async (options) => {
            const files = await storage.listCacheFiles(true); // Always return absolute paths
            if (files.length === 0) {
                logger.info("Cache is empty.");
                return;
            }

            if (options.format === "json") {
                console.log(JSON.stringify(files, null, 2));
                return;
            }

            logger.info(chalk.cyan(`\nCached files (${files.length}):\n`));
            for (const file of files) {
                console.log(`  ${file}`);
            }
        });

    cacheCmd
        .command("clear")
        .description("Clear the cache")
        .action(async () => {
            try {
                const stats = await storage.getCacheStats();
                if (stats.count === 0) {
                    logger.info("Cache is already empty.");
                    return;
                }

                const shouldClear = await confirm({
                    message: `Delete ${stats.count} cached files (${(stats.totalSizeBytes / 1024).toFixed(1)} KB)?`,
                    default: false,
                });

                if (shouldClear) {
                    await storage.clearCache();
                    logger.info(chalk.green("Cache cleared."));
                } else {
                    logger.info("Cancelled.");
                }
            } catch (error) {
                if (error instanceof ExitPromptError) {
                    logger.info("\nOperation cancelled.");
                    process.exit(0);
                }
                throw error;
            }
        });
}
