import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import logger, { consoleLog } from "@app/logger";
import { DiffUtil } from "@app/utils/diff";
import { ExitPromptError } from "@inquirer/core";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { getGlobalOptions } from "./config.utils.js";

/**
 * Backup manager for MCP configuration files
 */
export class BackupManager {
    private backupDir: string;

    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
        this.backupDir = path.join(homeDir, ".mcp-manager", "backups");
        this.ensureBackupDir();
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
    async showDiff(oldContent: string, newContent: string, configPath: string): Promise<boolean> {
        // Check if there are actual changes by comparing content
        if (oldContent === newContent) {
            consoleLog.info(chalk.gray("No changes detected."));
            return false;
        }

        // Show prominent warning at TOP so it's visible even in truncated output
        const globalOpts = getGlobalOptions();
        if (!globalOpts.yes && !process.stdout.isTTY) {
            consoleLog.info(chalk.bgYellow.black.bold(" >>> REVIEW CHANGES BELOW - CONFIRMATION REQUIRED AT END <<< "));
        }

        consoleLog.info(chalk.bold(`\nChanges to ${configPath}:\n`));

        // Use DiffUtil to show diff using system diff command
        await DiffUtil.showDiff(oldContent, newContent, "old", "new");
        return true;
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
     * Uses global options for --yes flag
     */
    async askConfirmation(): Promise<boolean> {
        const globalOpts = getGlobalOptions();

        // If --yes flag is set globally, auto-confirm
        if (globalOpts.yes) {
            return true;
        }

        // Check if we're in non-interactive mode (no TTY)
        if (!process.stdout.isTTY) {
            consoleLog.info(chalk.bgRed.white.bold("\n !!! CHANGES NOT APPLIED !!! "));
            consoleLog.info(chalk.yellow("To auto-confirm, re-run with --yes or -y flag."));
            return false;
        }

        try {
            const confirmed = await confirm({
                message: "Are these changes okay?",
                default: true,
            });

            return confirmed;
        } catch (error) {
            if (error instanceof ExitPromptError) {
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
        } catch (error) {
            logger.error(`Failed to list backups: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
}
