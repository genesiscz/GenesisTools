import chokidar from "chokidar";
import minimist from "minimist";
import path from "path";
import fs from "fs";
import os from "os";
import logger from "../logger";
import chalk from "chalk";
import { spawn } from "child_process";

const argv = minimist(process.argv.slice(2), {
    alias: {
        v: "verbose",
        f: "filter",
        h: "help",
    },
    default: {
        filter: "**/*.d.ts",
    },
    boolean: ["verbose", "help"],
});

// Set up help message
if (argv.help || argv.h) {
    logger.info(
        chalk.cyan(`
npm-package-diff - Compare files between two versions of an npm package

Usage:
  tools npm-package-diff <package-name> <version1> <version2> [options]

Options:
  --filter, -f     Glob pattern to filter files (default: "**/*.d.ts")
  --verbose, -v    Enable verbose logging
  --help, -h       Show help message

Examples:
  tools npm-package-diff react 18.0.0 18.2.0
  tools npm-package-diff @types/node 18.0.0 20.0.0 --filter="**/*.d.ts"
  tools npm-package-diff lodash 4.17.20 4.17.21 --filter="**/*.js" -v

Behavior:
  1. Creates temporary directories for each version
  2. Installs specified package versions using yarn
  3. Watches file additions during installation
  4. Filters added files by glob pattern
  5. Shows diff between matching files from both versions
`)
    );
    process.exit(0);
}

// Get arguments
const [packageName, version1, version2] = argv._;

if (!packageName || !version1 || !version2) {
    logger.error(chalk.red("Error: Missing required arguments"));
    logger.info(chalk.yellow("Usage: tools npm-package-diff <package-name> <version1> <version2>"));
    logger.info(chalk.yellow("Use --help for more information"));
    process.exit(1);
}

const filterPattern = argv.filter;

const log = {
    info: (message: string) => logger.info(chalk.blue("ℹ️ ") + message),
    debug: (message: string) => (argv.verbose ? logger.info(chalk.gray("🔍 ") + message) : null),
    error: (message: string, err?: any) => logger.error(chalk.red("❌ ") + message + (err ? ": " + err : "")),
    warn: (message: string) => logger.info(chalk.yellow("⚠️ ") + message),
    success: (message: string) => logger.info(chalk.green("✅ ") + message),
    step: (message: string) => logger.info(chalk.magenta("📋 ") + message),
};

interface FileMetadata {
    path: string;
    absolutePath: string;
    size: number;
    mtime: Date;
    relativePath: string;
}

class PackageComparison {
    private tempDir: string;
    private dir1: string;
    private dir2: string;
    private addedFiles1: FileMetadata[] = [];
    private addedFiles2: FileMetadata[] = [];
    private watchers: any[] = [];

    constructor(packageName: string, private version1: string, private version2: string) {
        this.tempDir = path.join(os.tmpdir(), `diff-${packageName}`);
        this.dir1 = path.join(this.tempDir, version1);
        this.dir2 = path.join(this.tempDir, version2);
    }

    async setup(): Promise<void> {
        log.step(`Setting up temporary directories for ${packageName}@${this.version1} vs ${packageName}@${this.version2}`);
        
        // Clean up existing directories
        if (fs.existsSync(this.tempDir)) {
            log.debug(`Removing existing temp directory: ${this.tempDir}`);
            fs.rmSync(this.tempDir, { recursive: true, force: true });
        }

        // Create directories
        fs.mkdirSync(this.dir1, { recursive: true });
        fs.mkdirSync(this.dir2, { recursive: true });
        
        log.success(`Created directories:\n  ${this.dir1}\n  ${this.dir2}`);
    }

    private setupWatcher(directory: string, addedFiles: FileMetadata[]): any {
        log.debug(`Setting up watcher for: ${directory}`);
        
        const watcher = chokidar.watch(directory, {
            persistent: true,
            ignoreInitial: true,
            followSymlinks: true,
            alwaysStat: true,
        });

        watcher.on("add", (filepath: string, stats?: fs.Stats) => {
            if (stats) {
                const relativePath = path.relative(directory, filepath);
                const metadata: FileMetadata = {
                    path: filepath,
                    absolutePath: filepath,
                    size: stats.size,
                    mtime: stats.mtime,
                    relativePath: relativePath,
                };
                addedFiles.push(metadata);
                log.debug(`File added: ${relativePath} (${stats.size} bytes)`);
            }
        });

        watcher.on("error", (error) => {
            log.error(`Watcher error for ${directory}`, error);
        });

        this.watchers.push(watcher);
        return watcher;
    }

    async installPackages(): Promise<void> {
        log.step("Setting up watchers and installing packages...");
        
        // Setup watchers before installation
        this.setupWatcher(this.dir1, this.addedFiles1);
        this.setupWatcher(this.dir2, this.addedFiles2);

        // Give watchers time to initialize
        await new Promise(resolve => setTimeout(resolve, 500));

        // Install both packages in parallel
        const installPromises = [
            this.installPackageInDirectory(packageName, this.version1, this.dir1),
            this.installPackageInDirectory(packageName, this.version2, this.dir2),
        ];

        try {
            await Promise.all(installPromises);
            log.success("Both packages installed successfully");
        } catch (error) {
            log.error("Failed to install packages", error);
            throw error;
        }

        // Give time for all file events to be processed
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    private async installPackageInDirectory(pkg: string, version: string, dir: string): Promise<void> {
        log.debug(`Installing ${pkg}@${version} in ${dir}`);
        
        // Sanitize package name for use in package.json
        const sanitizePackageName = (name: string): string => {
            // Replace all invalid characters with hyphens
            // This replaces /, ., @, and other special characters
            return name.replace(/[^\w-]/g, '-').replace(/^@/, '');
        };
        
        const sanitizedPkgName = sanitizePackageName(pkg);
        
        // Initialize package.json
        const packageJson = {
            name: `temp-${sanitizedPkgName}-${version}`,
            version: "1.0.0",
            dependencies: {
                [pkg]: version
            }
        };

        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson, null, 2));

        // Run yarn install
        return new Promise((resolve, reject) => {
            const yarnProcess = spawn("yarn", ["install"], {
                cwd: dir,
                stdio: argv.verbose ? "inherit" : "pipe",
            });

            yarnProcess.on("close", (code) => {
                if (code === 0) {
                    log.debug(`Successfully installed ${pkg}@${version}`);
                    resolve();
                } else {
                    reject(new Error(`yarn install failed with code ${code} for ${pkg}@${version}`));
                }
            });

            yarnProcess.on("error", (error) => {
                reject(error);
            });
        });
    }

    async filterAndCompareFiles(): Promise<void> {
        log.step(`Filtering files with pattern: ${filterPattern}`);

        // Filter files based on the glob pattern
        const filteredFiles1 = this.addedFiles1.filter(file => 
            this.matchesFilter(file.relativePath, filterPattern)
        );
        const filteredFiles2 = this.addedFiles2.filter(file => 
            this.matchesFilter(file.relativePath, filterPattern)
        );

        log.info(`Found ${filteredFiles1.length} matching files in ${this.version1}`);
        log.info(`Found ${filteredFiles2.length} matching files in ${this.version2}`);

        if (filteredFiles1.length === 0 && filteredFiles2.length === 0) {
            log.warn("No files match the filter pattern in either version");
            return;
        }

        // Create maps for easier lookup
        const files1Map = new Map(filteredFiles1.map(f => [f.relativePath, f]));
        const files2Map = new Map(filteredFiles2.map(f => [f.relativePath, f]));

        // Get all unique file paths
        const allPaths = new Set([...files1Map.keys(), ...files2Map.keys()]);

        log.step("Comparing files...");

        for (const filePath of Array.from(allPaths).sort()) {
            const file1 = files1Map.get(filePath);
            const file2 = files2Map.get(filePath);

            if (file1 && file2) {
                await this.compareFiles(file1, file2);
            } else if (file1 && !file2) {
                this.showFileOnlyIn(file1, this.version1);
            } else if (!file1 && file2) {
                this.showFileOnlyIn(file2, this.version2);
            }
        }
    }

    private matchesFilter(filePath: string, pattern: string): boolean {
        // Use minimatch-style matching
        const { minimatch } = require("minimatch");
        return minimatch(filePath, pattern);
    }

    private async compareFiles(file1: FileMetadata, file2: FileMetadata): Promise<void> {
        try {
            const content1 = fs.readFileSync(file1.absolutePath, "utf8");
            const content2 = fs.readFileSync(file2.absolutePath, "utf8");

            if (content1 === content2) {
                log.debug(`Files identical: ${file1.relativePath}`);
                return;
            }

            logger.info(chalk.cyan(`\n📄 DIFF: ${file1.relativePath}`));
            logger.info(chalk.blue(`Version ${this.version1} vs ${this.version2}`));
            
            // Simple line-by-line diff
            const lines1 = content1.split("\n");
            const lines2 = content2.split("\n");
            
            const maxLines = Math.max(lines1.length, lines2.length);
            let hasChanges = false;

            for (let i = 0; i < maxLines; i++) {
                const line1 = lines1[i] || "";
                const line2 = lines2[i] || "";

                if (line1 !== line2) {
                    if (!hasChanges) {
                        logger.info(chalk.cyan("┌" + "─".repeat(78) + "┐"));
                        hasChanges = true;
                    }

                    if (line1 && !line2) {
                        logger.info(chalk.red(`-${i + 1}: ${line1}`));
                    } else if (!line1 && line2) {
                        logger.info(chalk.green(`+${i + 1}: ${line2}`));
                    } else {
                        logger.info(chalk.red(`-${i + 1}: ${line1}`));
                        logger.info(chalk.green(`+${i + 1}: ${line2}`));
                    }
                }
            }

            if (hasChanges) {
                logger.info(chalk.cyan("└" + "─".repeat(78) + "┘"));
            }

        } catch (error) {
            log.error(`Error comparing files ${file1.relativePath}`, error);
        }
    }

    private showFileOnlyIn(file: FileMetadata, version: string): void {
        logger.info(chalk.yellow(`\n📄 ONLY IN ${version}: ${file.relativePath}`));
        
        try {
            const content = fs.readFileSync(file.absolutePath, "utf8");
            const lines = content.split("\n");
            
            logger.info(chalk.cyan("┌" + "─".repeat(78) + "┐"));
            
            // Show first 20 lines of the file
            const linesToShow = Math.min(lines.length, 20);
            for (let i = 0; i < linesToShow; i++) {
                logger.info(chalk.cyan("│ ") + lines[i]);
            }
            
            if (lines.length > 20) {
                logger.info(chalk.cyan("│ ") + chalk.gray(`... (${lines.length - 20} more lines)`));
            }
            
            logger.info(chalk.cyan("└" + "─".repeat(78) + "┘"));
        } catch (error) {
            log.error(`Error reading file ${file.relativePath}`, error);
        }
    }

    async cleanup(): Promise<void> {
        log.step("Cleaning up...");
        
        // Close watchers
        for (const watcher of this.watchers) {
            await watcher.close();
        }

        // Optionally remove temp directory
        if (fs.existsSync(this.tempDir)) {
            fs.rmSync(this.tempDir, { recursive: true, force: true });
            log.debug(`Removed temp directory: ${this.tempDir}`);
        }

        log.success("Cleanup completed");
    }

    printSummary(): void {
        logger.info(chalk.magenta("\n📊 SUMMARY:"));
        logger.info(chalk.blue(`Package: ${packageName}`));
        logger.info(chalk.blue(`Version 1: ${this.version1} (${this.addedFiles1.length} files added)`));
        logger.info(chalk.blue(`Version 2: ${this.version2} (${this.addedFiles2.length} files added)`));
        logger.info(chalk.blue(`Filter: ${filterPattern}`));
    }
}

async function main(): Promise<void> {
    const comparison = new PackageComparison(packageName, version1, version2);

    try {
        await comparison.setup();
        await comparison.installPackages();
        await comparison.filterAndCompareFiles();
        comparison.printSummary();
    } catch (error) {
        log.error("Comparison failed", error);
        process.exit(1);
    } finally {
        await comparison.cleanup();
    }
}

// Handle process termination
process.on("SIGINT", async () => {
    log.warn("Process interrupted, cleaning up...");
    process.exit(0);
});

process.on("SIGTERM", async () => {
    log.warn("Process terminated, cleaning up...");
    process.exit(0);
});

// Start the application
main().catch((error) => {
    logger.error("Fatal error:", error);
    process.exit(1);
}); 