import Enquirer from "enquirer";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import type { TimelyArgs } from "../types";

const prompter = new Enquirer();

export async function cacheCommand(args: TimelyArgs, storage: Storage): Promise<void> {
    const subcommand = args._[1];

    switch (subcommand) {
        case "list": {
            const files = await storage.listCacheFiles(true); // Always return absolute paths
            if (files.length === 0) {
                logger.info("Cache is empty.");
                return;
            }

            if (args.format === "json") {
                console.log(JSON.stringify(files, null, 2));
                return;
            }

            logger.info(chalk.cyan(`\nCached files (${files.length}):\n`));
            for (const file of files) {
                console.log(`  ${file}`);
            }
            break;
        }

        case "clear": {
            const stats = await storage.getCacheStats();
            if (stats.count === 0) {
                logger.info("Cache is already empty.");
                return;
            }

            const { confirm } = (await prompter.prompt({
                type: "confirm",
                name: "confirm",
                message: `Delete ${stats.count} cached files (${(stats.totalSizeBytes / 1024).toFixed(1)} KB)?`,
                initial: false,
            })) as { confirm: boolean };

            if (confirm) {
                await storage.clearCache();
                logger.info(chalk.green("Cache cleared."));
            } else {
                logger.info("Cancelled.");
            }
            break;
        }

        default:
            logger.info(`
Usage: tools timely cache <subcommand>

Subcommands:
  list    List all cached files
  clear   Clear the cache
`);
    }
}
