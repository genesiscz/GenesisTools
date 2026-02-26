import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import logger, { consoleLog } from "@app/logger";
import chalk from "chalk";

// Use consoleLog for clean diff output (no timestamps, no level for info)
const diffLogger = consoleLog;

/**
 * Utility for showing diffs using system diff command
 */
export class DiffUtil {
    /**
     * Show diff between two strings using system diff command
     * @param oldContent The old content
     * @param newContent The new content
     * @param oldLabel Label for old content (e.g., "Current")
     * @param newLabel Label for new content (e.g., "Incoming")
     * @returns Promise that resolves when diff is shown
     */
    static async showDiff(
        oldContent: string,
        newContent: string,
        oldLabel: string = "old",
        newLabel: string = "new"
    ): Promise<void> {
        // Create temporary files
        const tmpDir = tmpdir();
        const oldFile = join(tmpDir, `diff-old-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        const newFile = join(tmpDir, `diff-new-${Date.now()}-${Math.random().toString(36).substring(7)}`);

        try {
            // Write content to temp files
            await writeFile(oldFile, oldContent, "utf-8");
            await writeFile(newFile, newContent, "utf-8");

            // Run diff command with at least 20 lines of context
            return new Promise((resolve) => {
                const proc = spawn("diff", ["-U", "20", oldFile, newFile], {
                    stdio: ["ignore", "pipe", "pipe"],
                });

                let stdout = "";
                let stderr = "";

                proc.stdout.on("data", (data) => {
                    stdout += data.toString();
                });

                proc.stderr.on("data", (data) => {
                    stderr += data.toString();
                });

                proc.on("close", (code) => {
                    // Clean up temp files
                    Promise.all([unlink(oldFile).catch(() => {}), unlink(newFile).catch(() => {})]).finally(() => {
                        if (code === 0) {
                            // No differences
                            diffLogger.info(chalk.gray("No differences found."));
                            resolve();
                        } else if (code === 1) {
                            // Differences found - this is expected
                            // Parse and format the diff output
                            const formatted = DiffUtil.formatDiffOutput(stdout, oldLabel, newLabel);
                            // Output using logger without timestamps
                            diffLogger.info(formatted);
                            resolve();
                        } else {
                            // Error (code 2)
                            if (stderr) {
                                logger.error(chalk.red(`Diff error: ${stderr}`));
                            }
                            // Fallback: show a simple comparison
                            logger.warn(chalk.yellow("Could not generate diff. Showing content comparison:"));
                            diffLogger.info(chalk.red(`--- ${oldLabel}`));
                            diffLogger.info(oldContent);
                            diffLogger.info(chalk.green(`+++ ${newLabel}`));
                            diffLogger.info(newContent);
                            resolve();
                        }
                    });
                });

                proc.on("error", (error) => {
                    // Clean up temp files
                    Promise.all([unlink(oldFile).catch(() => {}), unlink(newFile).catch(() => {})]).finally(() => {
                        logger.error(chalk.red(`Failed to run diff command: ${error.message}`));
                        // Fallback: show a simple comparison
                        logger.warn(chalk.yellow("Could not generate diff. Showing content comparison:"));
                        diffLogger.info(chalk.red(`--- ${oldLabel}`));
                        diffLogger.info(oldContent);
                        diffLogger.info(chalk.green(`+++ ${newLabel}`));
                        diffLogger.info(newContent);
                        resolve();
                    });
                });
            });
        } catch (error) {
            // Clean up temp files on error
            await Promise.all([unlink(oldFile).catch(() => {}), unlink(newFile).catch(() => {})]);
            logger.error(chalk.red(`Failed to create diff: ${error instanceof Error ? error.message : String(error)}`));
            // Fallback: show a simple comparison
            logger.warn(chalk.yellow("Could not generate diff. Showing content comparison:"));
            diffLogger.info(chalk.red(`--- ${oldLabel}`));
            diffLogger.info(oldContent);
            diffLogger.info(chalk.green(`+++ ${newLabel}`));
            diffLogger.info(newContent);
        }
    }

    /**
     * Format diff output with colors
     */
    private static formatDiffOutput(diffOutput: string, oldLabel: string, newLabel: string): string {
        const lines = diffOutput.split("\n");
        let formatted = "\n";

        // Replace file paths in diff header with labels
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("---")) {
                formatted += chalk.red(`--- ${oldLabel}\n`);
            } else if (line.startsWith("+++")) {
                formatted += chalk.green(`+++ ${newLabel}\n`);
            } else if (line.startsWith("-")) {
                formatted += `${chalk.red(line)}\n`;
            } else if (line.startsWith("+")) {
                formatted += `${chalk.green(line)}\n`;
            } else if (line.startsWith("@")) {
                formatted += `${chalk.cyan(line)}\n`;
            } else {
                formatted += `${line}\n`;
            }
        }

        return formatted;
    }

    /**
     * Compare two objects and check if they differ in specific fields
     * @param oldObj The old object
     * @param newObj The new object
     * @param fields Fields to compare (defaults to ['args', 'name', 'env'])
     * @returns Object with conflict info: { hasConflict: boolean, differences: string[] }
     */
    static detectConflicts(
        oldObj: Record<string, unknown>,
        newObj: Record<string, unknown>,
        fields: string[] = ["args", "name", "env"]
    ): { hasConflict: boolean; differences: string[] } {
        const differences: string[] = [];

        for (const field of fields) {
            const oldValue = oldObj[field];
            const newValue = newObj[field];

            // Deep comparison using JSON.stringify for simplicity
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
                differences.push(field);
            }
        }

        return {
            hasConflict: differences.length > 0,
            differences,
        };
    }
}
