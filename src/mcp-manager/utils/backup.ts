import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile, copyFile } from "fs/promises";
import path from "path";
import * as diff from "diff";
import chalk from "chalk";
import logger from "@app/logger";
import Enquirer from "enquirer";

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
    showDiff(oldContent: string, newContent: string, configPath: string): void {
        const changes = diff.diffLines(oldContent, newContent);

        // Check if there are actual changes
        const hasChanges = changes.some((part) => part.added || part.removed);

        if (!hasChanges) {
            logger.info(chalk.gray("No changes detected."));
            return;
        }

        logger.info(chalk.bold(`\nChanges to ${configPath}:\n`));

        const contextLimit = 3;
        let lastWasContext = false;

        for (let i = 0; i < changes.length; i++) {
            const part = changes[i];
            const lines = part.value.split("\n");
            // Remove trailing empty line from split
            if (lines.length > 0 && lines[lines.length - 1] === "") {
                lines.pop();
            }

            if (part.added) {
                lastWasContext = false;
                for (const line of lines) {
                    if (line !== "") {
                        logger.info(chalk.green(`+ ${line}`));
                    }
                }
            } else if (part.removed) {
                lastWasContext = false;
                for (const line of lines) {
                    if (line !== "") {
                        logger.info(chalk.red(`- ${line}`));
                    }
                }
            } else {
                // Context lines - show limited context around changes
                const isFirst = i === 0;
                const isLast = i === changes.length - 1;
                const hasNextChange = i < changes.length - 1 && (changes[i + 1].added || changes[i + 1].removed);
                const hasPrevChange = i > 0 && (changes[i - 1].added || changes[i - 1].removed);

                if (isFirst || isLast || hasNextChange || hasPrevChange) {
                    // Show context around changes
                    if (lines.length > contextLimit * 2 && !isFirst && !isLast) {
                        // Show first few and last few lines with ellipsis
                        const firstLines = lines.slice(0, contextLimit);
                        const lastLines = lines.slice(-contextLimit);

                        for (const line of firstLines) {
                            if (line !== "") {
                                logger.info(chalk.gray(`  ${line}`));
                            }
                        }
                        logger.info(chalk.gray("  ..."));
                        for (const line of lastLines) {
                            if (line !== "") {
                                logger.info(chalk.gray(`  ${line}`));
                            }
                        }
                    } else {
                        // Show all context lines
                        for (const line of lines) {
                            if (line !== "") {
                                logger.info(chalk.gray(`  ${line}`));
                            }
                        }
                    }
                    lastWasContext = true;
                }
            }
        }

        logger.info(""); // Empty line after diff
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
        // This would require reading the directory, but for now we'll keep it simple
        return [];
    }
}
