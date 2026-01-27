import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Optional logger interface for DiffUtil
 */
export interface DiffLogger {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
}

const noopLogger: DiffLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
};

/**
 * Color function type for formatting diff output
 */
export interface DiffColorizer {
    red: (text: string) => string;
    green: (text: string) => string;
    cyan: (text: string) => string;
    gray: (text: string) => string;
    yellow: (text: string) => string;
}

const noopColorizer: DiffColorizer = {
    red: (text) => text,
    green: (text) => text,
    cyan: (text) => text,
    gray: (text) => text,
    yellow: (text) => text,
};

/**
 * Options for DiffUtil
 */
export interface DiffOptions {
    logger?: DiffLogger;
    colorizer?: DiffColorizer;
}

/**
 * Utility for showing diffs using system diff command
 */
export class DiffUtil {
    private logger: DiffLogger;
    private colorizer: DiffColorizer;

    constructor(options: DiffOptions = {}) {
        this.logger = options.logger || noopLogger;
        this.colorizer = options.colorizer || noopColorizer;
    }

    /**
     * Show diff between two strings using system diff command
     * @param oldContent The old content
     * @param newContent The new content
     * @param oldLabel Label for old content (e.g., "Current")
     * @param newLabel Label for new content (e.g., "Incoming")
     * @returns Promise that resolves when diff is shown
     */
    async showDiff(
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
                            this.logger.info(this.colorizer.gray("No differences found."));
                            resolve();
                        } else if (code === 1) {
                            // Differences found - this is expected
                            const formatted = this.formatDiffOutput(stdout, oldLabel, newLabel);
                            this.logger.info(formatted);
                            resolve();
                        } else {
                            // Error (code 2)
                            if (stderr) {
                                this.logger.error(this.colorizer.red(`Diff error: ${stderr}`));
                            }
                            // Fallback: show a simple comparison
                            this.logger.warn(this.colorizer.yellow("Could not generate diff. Showing content comparison:"));
                            this.logger.info(this.colorizer.red(`--- ${oldLabel}`));
                            this.logger.info(oldContent);
                            this.logger.info(this.colorizer.green(`+++ ${newLabel}`));
                            this.logger.info(newContent);
                            resolve();
                        }
                    });
                });

                proc.on("error", (error) => {
                    // Clean up temp files
                    Promise.all([unlink(oldFile).catch(() => {}), unlink(newFile).catch(() => {})]).finally(() => {
                        this.logger.error(this.colorizer.red(`Failed to run diff command: ${error.message}`));
                        // Fallback: show a simple comparison
                        this.logger.warn(this.colorizer.yellow("Could not generate diff. Showing content comparison:"));
                        this.logger.info(this.colorizer.red(`--- ${oldLabel}`));
                        this.logger.info(oldContent);
                        this.logger.info(this.colorizer.green(`+++ ${newLabel}`));
                        this.logger.info(newContent);
                        resolve();
                    });
                });
            });
        } catch (error) {
            // Clean up temp files on error
            await Promise.all([unlink(oldFile).catch(() => {}), unlink(newFile).catch(() => {})]);
            this.logger.error(this.colorizer.red(`Failed to create diff: ${(error as Error).message}`));
            // Fallback: show a simple comparison
            this.logger.warn(this.colorizer.yellow("Could not generate diff. Showing content comparison:"));
            this.logger.info(this.colorizer.red(`--- ${oldLabel}`));
            this.logger.info(oldContent);
            this.logger.info(this.colorizer.green(`+++ ${newLabel}`));
            this.logger.info(newContent);
        }
    }

    /**
     * Format diff output with colors
     */
    private formatDiffOutput(diffOutput: string, oldLabel: string, newLabel: string): string {
        const lines = diffOutput.split("\n");
        let formatted = "\n";

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("---")) {
                formatted += this.colorizer.red(`--- ${oldLabel}\n`);
            } else if (line.startsWith("+++")) {
                formatted += this.colorizer.green(`+++ ${newLabel}\n`);
            } else if (line.startsWith("-")) {
                formatted += this.colorizer.red(line) + "\n";
            } else if (line.startsWith("+")) {
                formatted += this.colorizer.green(line) + "\n";
            } else if (line.startsWith("@")) {
                formatted += this.colorizer.cyan(line) + "\n";
            } else {
                formatted += line + "\n";
            }
        }

        return formatted;
    }

    /**
     * Static showDiff for backwards compatibility
     * Usage: DiffUtil.showDiff(oldContent, newContent, oldLabel, newLabel)
     */
    static async showDiff(
        oldContent: string,
        newContent: string,
        oldLabel: string = "old",
        newLabel: string = "new"
    ): Promise<void> {
        const util = new DiffUtil();
        return util.showDiff(oldContent, newContent, oldLabel, newLabel);
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

/**
 * Static methods for backwards compatibility
 */
export const showDiff = async (
    oldContent: string,
    newContent: string,
    oldLabel?: string,
    newLabel?: string,
    options?: DiffOptions
): Promise<void> => {
    const util = new DiffUtil(options);
    return util.showDiff(oldContent, newContent, oldLabel, newLabel);
};

export const detectConflicts = DiffUtil.detectConflicts;
