import logger from "@app/logger";
import { BackupManager } from "@app/mcp-manager/utils/backup.js";
import { getUnifiedConfigPath } from "@app/mcp-manager/utils/config.utils.js";
import type { MCPProvider } from "@app/mcp-manager/utils/providers/types.js";
import chalk from "chalk";
import { existsSync } from "fs";
import path from "path";

/**
 * Backup all configs for all providers and the unified config
 */
export async function backupAllConfigs(providers: MCPProvider[]): Promise<void> {
    const backupManager = new BackupManager();
    const backupMap: Map<string, string> = new Map();

    logger.info("Creating backups for all provider configs...\n");

    // Backup unified config if it exists
    const unifiedConfigPath = getUnifiedConfigPath();
    if (existsSync(unifiedConfigPath)) {
        const unifiedBackupPath = await backupManager.createBackup(unifiedConfigPath, "unified");
        if (unifiedBackupPath) {
            const absoluteOriginal = path.resolve(unifiedConfigPath);
            const absoluteBackup = path.resolve(unifiedBackupPath);
            backupMap.set(absoluteOriginal, absoluteBackup);
            logger.info(chalk.green(`✓ Backed up unified config: ${absoluteBackup}`));
        }
    }

    // Backup all provider configs
    for (const provider of providers) {
        if (await provider.configExists()) {
            const configPath = provider.getConfigPath();
            const providerName = provider.getName();
            const backupPath = await backupManager.createBackup(configPath, providerName);

            if (backupPath) {
                const absoluteOriginal = path.resolve(configPath);
                const absoluteBackup = path.resolve(backupPath);
                backupMap.set(absoluteOriginal, absoluteBackup);
                logger.info(chalk.green(`✓ Backed up ${providerName}: ${absoluteBackup}`));
            }
        } else {
            logger.debug(`Skipping ${provider.getName()} (config does not exist)`);
        }
    }

    if (backupMap.size === 0) {
        logger.warn("No configs found to backup.");
        return;
    }

    // Log the map of original files to backup paths
    logger.info(chalk.bold("\nBackup Summary:\n"));
    logger.info("Original file → Backup file:");
    for (const [original, backup] of backupMap.entries()) {
        logger.info(`  ${chalk.cyan(original)}`);
        logger.info(`    → ${chalk.green(backup)}`);
    }
    logger.info(`\n✓ Successfully backed up ${backupMap.size} config file(s)`);
}
