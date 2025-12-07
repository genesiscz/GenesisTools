import { existsSync, mkdirSync, readdirSync } from "fs";
import { copyFile } from "fs/promises";
import path from "path";
import chalk from "chalk";
import logger, { consoleLog } from "@app/logger";
import Enquirer from "enquirer";
import { DiffUtil } from "@app/utils/diff";

/**
 * Backup manager for MCP configuration files
 */
export class BackupManager {
    private backupDir: string;
    private prompter: Enquirer;

    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
        this.backupDir = path.join(homeDir, ".mcp-manager", "backups");
        this.ensureBackupDir();
        this.prompter = new Enquirer();
    }

    private ensureBackupDir(): void {
        if (!existsSync(this.backupDir)) {
            mkdirSync(this.backupDir, { recursive: true });
        }
    }

    /**
     * Create a backup of a configuration file
     */
    async createBackup(configPath: string, providerName: string): Promise<string> {
        if (!existsSync(configPath)) {
            // No existing config to backup
            return "";
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = path.basename(configPath);
        const backupFileName = `${providerName}-${fileName}-${timestamp}.backup`;
        const backupPath = path.join(this.backupDir, backupFileName);

        await copyFile(configPath, backupPath);
        return backupPath;
    }

    /**
     * Show diff between old and new configuration
     */
    async showDiff(oldContent: string, newContent: string, configPath: string): Promise<void> {
        // Check if there are actual changes by comparing content
        if (oldContent === newContent) {
            consoleLog.info(chalk.gray("No changes detected."));
            return;
        }

        consoleLog.info(chalk.bold(`\nChanges to ${configPath}:\n`));

        // Use DiffUtil to show diff using system diff command
        await DiffUtil.showDiff(oldContent, newContent, "old", "new");
    }

    /**
     * Get backup file path for a specific provider
     */
    getBackupPath(configPath: string, providerName: string): string {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = path.basename(configPath);
        return path.join(this.backupDir, `${providerName}-${fileName}-${timestamp}.backup`);
    }

    /**
     * Restore a configuration file from a backup
     */
    async restoreFromBackup(configPath: string, backupPath: string): Promise<void> {
        if (!existsSync(backupPath)) {
            throw new Error(`Backup file not found: ${backupPath}`);
        }

        await copyFile(backupPath, configPath);
        logger.info(chalk.green(`✓ Restored configuration from backup: ${backupPath}`));
    }

    /**
     * Ask user for confirmation before applying changes
     */
    async askConfirmation(): Promise<boolean> {
        try {
            const { confirmed } = (await this.prompter.prompt({
                type: "confirm",
                name: "confirmed",
                message: "Are these changes okay?",
                initial: true,
            })) as { confirmed: boolean };

            return confirmed;
        } catch (error: any) {
            if (error.message === "canceled") {
                logger.info("\nOperation cancelled by user.");
                return false;
            }
            throw error;
        }
    }

    /**
     * List all backups for a provider
     */
    async listBackups(providerName: string): Promise<string[]> {
        if (!existsSync(this.backupDir)) {
            return [];
        }

        try {
            const files = readdirSync(this.backupDir);
            // Filter files that match the provider name pattern: providerName-filename-timestamp.backup
            const backupFiles = files
                .filter((file) => {
                    // Check if file starts with provider name and ends with .backup
                    return file.startsWith(`${providerName}-`) && file.endsWith(".backup");
                })
                .map((file) => path.join(this.backupDir, file))
                .sort()
                .reverse(); // Most recent first

            return backupFiles;
        } catch (error: any) {
            logger.error(`Failed to list backups: ${error.message}`);
            return [];
        }
    }
}
