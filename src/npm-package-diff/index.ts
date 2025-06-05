import chokidar from "chokidar";
import minimist from "minimist";
import path from "path";
import fs from "fs";
import os from "os";
import chalk from "chalk";
import { spawn } from "child_process";
import * as diff from "diff";
import { minimatch } from "minimatch";
import ora from "ora";
import Table from "cli-table3";
import { filesize } from "filesize";
import boxen from "boxen";
import { createRequire } from "module";
import { execSync } from "child_process";

const require = createRequire(import.meta.url);

// Custom logger that respects output redirection
const createSimpleLogger = () => {
    const isTTY = process.stdout.isTTY;
    const isVerbose = process.argv.includes("-v") || process.argv.includes("--verbose");
    const isSilent = process.argv.includes("--silent");
    const isDebug = process.argv.includes("-vv") || process.argv.includes("--debug");
    
    return {
        info: (msg: string) => {
            if (!isSilent) {
                if (isTTY) {
                    console.log(msg);
                } else {
                    // Strip ANSI codes for non-TTY output
                    console.log(msg.replace(/\u001b\[[0-9;]*m/g, ''));
                }
            }
        },
        error: (msg: string) => {
            if (isTTY) {
                console.error(msg);
            } else {
                console.error(msg.replace(/\u001b\[[0-9;]*m/g, ''));
            }
        },
        debug: (msg: string) => {
            if ((isVerbose || isDebug) && !isSilent) {
                if (isTTY) {
                    console.log(chalk.gray(`[DEBUG] ${msg}`));
                } else {
                    console.log(`[DEBUG] ${msg}`);
                }
            }
        },
        success: (msg: string) => {
            if (!isSilent && isTTY) {
                console.log(chalk.green(msg));
            } else if (!isSilent) {
                console.log(msg);
            }
        },
        warn: (msg: string) => {
            if (!isSilent) {
                if (isTTY) {
                    console.warn(chalk.yellow(msg));
                } else {
                    console.warn(msg);
                }
            }
        }
    };
};

const logger = createSimpleLogger();

const argv = minimist(process.argv.slice(2), {
    alias: {
        v: "verbose",
        f: "filter",
        h: "help",
        o: "output",
        F: "format",
        e: "exclude",
        p: "patch",
        c: "config",
        s: "silent",
        m: "package-manager"
    },
    default: {
        filter: "**/*.d.ts",
        format: "terminal",
        output: null,
        lineNumbers: true,
        context: 3,
        timeout: 120000, // 2 minutes default
        packageManager: "auto"
    },
    boolean: ["verbose", "help", "silent", "stats", "sizes", "line-numbers", "word-diff", "side-by-side", "use-delta"],
    string: ["filter", "output", "format", "exclude", "patch", "config", "delta-theme", "npmrc", "package-manager"],
    number: ["timeout"]
});

// Configuration loading
const loadConfig = (configPath?: string): any => {
    const defaultConfigPath = path.join(process.cwd(), ".npmpackagediffrc");
    const configFile = configPath || (fs.existsSync(defaultConfigPath) ? defaultConfigPath : null);
    
    if (configFile && fs.existsSync(configFile)) {
        try {
            const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
            logger.debug(`Loaded config from ${configFile}`);
            return config;
        } catch (e) {
            logger.warn(`Failed to load config from ${configFile}: ${e}`);
        }
    }
    return {};
};

// Merge config with CLI args
const config = { ...loadConfig(argv.config), ...argv };

// Help message
if (config.help) {
    const helpText = `
${boxen(chalk.bold.cyan("NPM Package Diff"), { 
    padding: 1, 
    margin: 1, 
    borderStyle: "round",
    borderColor: "cyan"
})}

${chalk.bold("USAGE:")}
  npm-package-diff <package-name> <version1> <version2> [options]

${chalk.bold("OPTIONS:")}
  ${chalk.cyan("--filter, -f")}         Glob pattern to filter files (default: "**/*.d.ts")
  ${chalk.cyan("--exclude, -e")}        Glob pattern to exclude files
  ${chalk.cyan("--output, -o")}         Output file path (default: console)
  ${chalk.cyan("--format, -F")}         Output format: terminal, unified, html, json, side-by-side
                       (default: "terminal")
  ${chalk.cyan("--patch, -p")}          Generate patch file
  ${chalk.cyan("--verbose, -v")}        Enable verbose logging
  ${chalk.cyan("--silent, -s")}         Suppress all output except errors
  ${chalk.cyan("--help, -h")}           Show help message
  ${chalk.cyan("--stats")}              Show statistics summary
  ${chalk.cyan("--sizes")}              Compare file sizes
  ${chalk.cyan("--line-numbers")}       Show line numbers (default: true)
  ${chalk.cyan("--word-diff")}          Show word-level differences
  ${chalk.cyan("--side-by-side")}       Show side-by-side diff in terminal
  ${chalk.cyan("--context")}            Number of context lines (default: 3)
  ${chalk.cyan("--config, -c")}         Path to config file (default: .npmpackagediffrc)
  ${chalk.cyan("--use-delta")}          Use delta for terminal output (if installed)
  ${chalk.cyan("--delta-theme")}        Delta theme to use (light/dark)
  ${chalk.cyan("--timeout")}            Installation timeout in ms (default: 120000)
  ${chalk.cyan("--npmrc")}              Path to .npmrc file for authentication
  ${chalk.cyan("--package-manager")}    Package manager: auto, npm, yarn, pnpm, bun
                       (default: "auto")

${chalk.bold("OUTPUT FORMATS:")}
  ${chalk.yellow("terminal")}       - Colored diff in terminal (default)
  ${chalk.yellow("unified")}        - Unified diff format (can be used as .patch)
  ${chalk.yellow("html")}           - HTML output with syntax highlighting
  ${chalk.yellow("json")}           - JSON format with detailed changes
  ${chalk.yellow("side-by-side")}   - Side-by-side comparison in terminal

${chalk.bold("EXAMPLES:")}
  ${chalk.gray("# Basic usage with TypeScript definitions")}
  npm-package-diff react 18.0.0 18.2.0

  ${chalk.gray("# Compare all JavaScript files")}
  npm-package-diff lodash 4.17.20 4.17.21 --filter="**/*.js"

  ${chalk.gray("# Generate a patch file")}
  npm-package-diff express 4.17.0 4.18.0 --patch express.patch

  ${chalk.gray("# Create HTML report")}
  npm-package-diff @types/node 18.0.0 20.0.0 --format html -o report.html

  ${chalk.gray("# Show side-by-side diff with statistics")}
  npm-package-diff axios 0.27.0 1.0.0 --side-by-side --stats

  ${chalk.gray("# Use delta for beautiful terminal output")}
  npm-package-diff typescript 4.9.0 5.0.0 --use-delta

  ${chalk.gray("# Use specific package manager with custom .npmrc")}
  npm-package-diff @private/package 1.0.0 2.0.0 --package-manager pnpm --npmrc ~/.npmrc

  ${chalk.gray("# Set custom timeout for slow networks")}
  npm-package-diff large-package 1.0.0 2.0.0 --timeout 300000

${chalk.bold("CONFIG FILE EXAMPLE (.npmpackagediffrc):")}
${chalk.gray(`{
  "filter": "**/*.{js,ts,jsx,tsx}",
  "exclude": "**/{test,tests,__tests__}/**",
  "format": "terminal",
  "lineNumbers": true,
  "wordDiff": false,
  "context": 3,
  "stats": true,
  "sizes": true,
  "timeout": 180000,
  "packageManager": "pnpm",
  "npmrc": "./.npmrc"
}`)}
`;
    logger.info(helpText);
    process.exit(0);
}

// Get arguments
const [packageName, version1, version2] = config._;

if (!packageName || !version1 || !version2) {
    logger.error(chalk.red("Error: Missing required arguments"));
    logger.info(chalk.yellow("Usage: npm-package-diff <package-name> <version1> <version2>"));
    logger.info(chalk.yellow("Use --help for more information"));
    process.exit(1);
}

interface FileMetadata {
    path: string;
    absolutePath: string;
    size: number;
    mtime: Date;
    relativePath: string;
}

interface DiffResult {
    file: string;
    status: "added" | "removed" | "modified" | "identical";
    oldSize?: number;
    newSize?: number;
    additions?: number;
    deletions?: number;
    changes?: diff.Change[];
    patch?: string;
}

type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

class EnhancedPackageComparison {
    private tempDir: string;
    private dir1: string;
    private dir2: string;
    private addedFiles1: FileMetadata[] = [];
    private addedFiles2: FileMetadata[] = [];
    private watchers: any[] = [];
    private spinner?: ora.Ora;
    private results: DiffResult[] = [];
    private packageManager: PackageManager;

    constructor(
        private packageName: string, 
        private version1: string, 
        private version2: string,
        private options: typeof config
    ) {
        this.tempDir = path.join(os.tmpdir(), `npm-diff-${packageName.replace(/[^a-zA-Z0-9]/g, '-')}`);
        this.dir1 = path.join(this.tempDir, version1);
        this.dir2 = path.join(this.tempDir, version2);
        this.packageManager = this.detectPackageManager();
    }

    private detectPackageManager(): PackageManager {
        if (this.options.packageManager && this.options.packageManager !== "auto") {
            return this.options.packageManager as PackageManager;
        }

        // Auto-detect based on lock files
        const cwd = process.cwd();
        if (fs.existsSync(path.join(cwd, "bun.lockb"))) {
            logger.debug("Detected bun from bun.lockb");
            return "bun";
        }
        if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
            logger.debug("Detected pnpm from pnpm-lock.yaml");
            return "pnpm";
        }
        if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
            logger.debug("Detected yarn from yarn.lock");
            return "yarn";
        }
        
        // Check if commands are available
        try {
            execSync('which pnpm', { stdio: 'ignore' });
            logger.debug("Using pnpm (found in PATH)");
            return "pnpm";
        } catch {}
        
        try {
            execSync('which bun', { stdio: 'ignore' });
            logger.debug("Using bun (found in PATH)");
            return "bun";
        } catch {}
        
        try {
            execSync('which yarn', { stdio: 'ignore' });
            logger.debug("Using yarn (found in PATH)");
            return "yarn";
        } catch {}
        
        logger.debug("Defaulting to npm");
        return "npm";
    }

    async setup(): Promise<void> {
        if (!this.options.silent) {
            this.spinner = ora({
                text: `Setting up comparison for ${chalk.cyan(this.packageName)}`,
                spinner: "dots"
            }).start();
        }
        
        // Clean up existing directories
        if (fs.existsSync(this.tempDir)) {
            logger.debug(`Removing existing temp directory: ${this.tempDir}`);
            fs.rmSync(this.tempDir, { recursive: true, force: true });
        }

        // Create directories
        fs.mkdirSync(this.dir1, { recursive: true });
        fs.mkdirSync(this.dir2, { recursive: true });
        
        // Copy .npmrc if specified
        if (this.options.npmrc) {
            const npmrcPath = path.resolve(this.options.npmrc);
            if (fs.existsSync(npmrcPath)) {
                const npmrcContent = fs.readFileSync(npmrcPath, 'utf8');
                fs.writeFileSync(path.join(this.dir1, '.npmrc'), npmrcContent);
                fs.writeFileSync(path.join(this.dir2, '.npmrc'), npmrcContent);
                logger.debug(`Copied .npmrc from ${npmrcPath}`);
            } else {
                logger.warn(`Specified .npmrc file not found: ${npmrcPath}`);
            }
        }
        
        this.spinner?.succeed(`Created temporary directories`);
    }

    private setupWatcher(directory: string, addedFiles: FileMetadata[]): any {
        logger.debug(`Setting up watcher for: ${directory}`);
        
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
                logger.debug(`File added: ${relativePath} (${filesize(stats.size)})`);
            }
        });

        watcher.on("error", (error) => {
            logger.error(`Watcher error for ${directory}: ${error}`);
        });

        this.watchers.push(watcher);
        return watcher;
    }

    async installPackages(): Promise<void> {
        if (!this.options.silent) {
            this.spinner = ora({
                text: `Installing packages using ${this.packageManager}...`,
                spinner: "dots"
            }).start();
        }
        
        // Setup watchers before installation
        this.setupWatcher(this.dir1, this.addedFiles1);
        this.setupWatcher(this.dir2, this.addedFiles2);

        // Give watchers time to initialize
        await new Promise(resolve => setTimeout(resolve, 500));

        // Install both packages in parallel
        const installPromises = [
            this.installPackageInDirectory(this.packageName, this.version1, this.dir1),
            this.installPackageInDirectory(this.packageName, this.version2, this.dir2),
        ];

        try {
            await Promise.all(installPromises);
            this.spinner?.succeed(`Installed both package versions`);
        } catch (error) {
            this.spinner?.fail(`Failed to install packages`);
            throw error;
        }

        // Give time for all file events to be processed
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    private async installPackageInDirectory(pkg: string, version: string, dir: string): Promise<void> {
        logger.debug(`Installing ${pkg}@${version} in ${dir} using ${this.packageManager}`);
        
        const sanitizePackageName = (name: string): string => {
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

        // Prepare install command based on package manager
        let installCmd: string;
        let installArgs: string[];
        
        switch (this.packageManager) {
            case "bun":
                installCmd = "bun";
                installArgs = ["install"];
                break;
            case "pnpm":
                installCmd = "pnpm";
                installArgs = ["install", "--no-lockfile"];
                break;
            case "yarn":
                installCmd = "yarn";
                installArgs = ["install", "--no-lockfile"];
                break;
            case "npm":
            default:
                installCmd = "npm";
                installArgs = ["install", "--no-package-lock"];
                break;
        }

        // Run install with timeout
        return new Promise((resolve, reject) => {
            const installProcess = spawn(installCmd, installArgs, {
                cwd: dir,
                stdio: this.options.verbose ? "inherit" : "pipe",
            });

            let timedOut = false;
            const timeout = setTimeout(() => {
                timedOut = true;
                installProcess.kill('SIGTERM');
                reject(new Error(`Installation timed out after ${this.options.timeout}ms for ${pkg}@${version}`));
            }, this.options.timeout);

            installProcess.on("close", (code) => {
                clearTimeout(timeout);
                if (timedOut) return;
                
                if (code === 0) {
                    logger.debug(`Successfully installed ${pkg}@${version}`);
                    resolve();
                } else {
                    reject(new Error(`${this.packageManager} install failed with code ${code} for ${pkg}@${version}`));
                }
            });

            installProcess.on("error", (error) => {
                clearTimeout(timeout);
                if (!timedOut) {
                    reject(error);
                }
            });
        });
    }

    private matchesFilter(filePath: string): boolean {
        const matchesInclude = minimatch(filePath, this.options.filter);
        const matchesExclude = this.options.exclude ? minimatch(filePath, this.options.exclude) : false;
        return matchesInclude && !matchesExclude;
    }

    async compareFiles(): Promise<void> {
        if (!this.options.silent) {
            this.spinner = ora({
                text: `Comparing files...`,
                spinner: "dots"
            }).start();
        }

        // Filter files based on the glob pattern
        const filteredFiles1 = this.addedFiles1.filter(file => 
            this.matchesFilter(file.relativePath)
        );
        const filteredFiles2 = this.addedFiles2.filter(file => 
            this.matchesFilter(file.relativePath)
        );

        logger.debug(`Found ${filteredFiles1.length} matching files in ${this.version1}`);
        logger.debug(`Found ${filteredFiles2.length} matching files in ${this.version2}`);

        // Create maps for easier lookup
        const files1Map = new Map(filteredFiles1.map(f => [f.relativePath, f]));
        const files2Map = new Map(filteredFiles2.map(f => [f.relativePath, f]));

        // Get all unique file paths
        const allPaths = new Set([...files1Map.keys(), ...files2Map.keys()]);

        for (const filePath of Array.from(allPaths).sort()) {
            const file1 = files1Map.get(filePath);
            const file2 = files2Map.get(filePath);

            if (file1 && file2) {
                await this.compareTwoFiles(file1, file2);
            } else if (file1 && !file2) {
                this.results.push({
                    file: filePath,
                    status: "removed",
                    oldSize: file1.size
                });
            } else if (!file1 && file2) {
                this.results.push({
                    file: filePath,
                    status: "added",
                    newSize: file2.size
                });
            }
        }

        this.spinner?.succeed(`Comparison complete`);
    }

    private async compareTwoFiles(file1: FileMetadata, file2: FileMetadata): Promise<void> {
        try {
            const content1 = fs.readFileSync(file1.absolutePath, "utf8");
            const content2 = fs.readFileSync(file2.absolutePath, "utf8");

            if (content1 === content2) {
                this.results.push({
                    file: file1.relativePath,
                    status: "identical",
                    oldSize: file1.size,
                    newSize: file2.size
                });
                return;
            }

            // Generate diff
            const changes = this.options.wordDiff 
                ? diff.diffWords(content1, content2)
                : diff.diffLines(content1, content2, { 
                    ignoreWhitespace: false,
                    newlineIsToken: true 
                });

            // Count additions and deletions
            let additions = 0;
            let deletions = 0;
            changes.forEach(change => {
                if (change.added) {
                    additions += change.count || 0;
                } else if (change.removed) {
                    deletions += change.count || 0;
                }
            });

            // Generate patch if needed
            const patch = diff.createTwoFilesPatch(
                file1.relativePath,
                file2.relativePath,
                content1,
                content2,
                `v${this.version1}`,
                `v${this.version2}`,
                { context: this.options.context }
            );

            this.results.push({
                file: file1.relativePath,
                status: "modified",
                oldSize: file1.size,
                newSize: file2.size,
                additions,
                deletions,
                changes,
                patch
            });

        } catch (error) {
            logger.error(`Error comparing files ${file1.relativePath}: ${error}`);
        }
    }

    private outputTerminalDiff(result: DiffResult): void {
        if (this.options.useDelta && this.isDeltaAvailable()) {
            this.outputWithDelta(result);
            return;
        }

        console.log(chalk.cyan(`\n${"=".repeat(80)}`));
        console.log(chalk.bold.white(`📄 ${result.file}`));
        
        if (result.status === "added") {
            console.log(chalk.green(`   Status: Added (${filesize(result.newSize || 0)})`));
        } else if (result.status === "removed") {
            console.log(chalk.red(`   Status: Removed (${filesize(result.oldSize || 0)})`));
        } else if (result.status === "modified") {
            console.log(chalk.yellow(`   Status: Modified`));
            console.log(chalk.gray(`   Size: ${filesize(result.oldSize || 0)} → ${filesize(result.newSize || 0)}`));
            console.log(chalk.green(`   +${result.additions} additions`), chalk.red(`-${result.deletions} deletions`));
        }
        console.log(chalk.cyan(`${"=".repeat(80)}`));

        if (result.changes && result.status === "modified") {
            if (this.options.sideBySide) {
                this.outputSideBySideDiff(result);
            } else {
                this.outputInlineDiff(result);
            }
        }
    }

    private outputInlineDiff(result: DiffResult): void {
        let lineNumber = 1;
        result.changes?.forEach(change => {
            const lines = change.value.split('\n').filter(line => line !== '');
            lines.forEach(line => {
                if (change.added) {
                    const lineNum = this.options.lineNumbers ? chalk.green(`+${lineNumber.toString().padStart(4)} `) : '';
                    console.log(chalk.green(`${lineNum}+ ${line}`));
                } else if (change.removed) {
                    const lineNum = this.options.lineNumbers ? chalk.red(`-${lineNumber.toString().padStart(4)} `) : '';
                    console.log(chalk.red(`${lineNum}- ${line}`));
                } else {
                    const lineNum = this.options.lineNumbers ? chalk.gray(` ${lineNumber.toString().padStart(4)} `) : '';
                    console.log(chalk.gray(`${lineNum}  ${line}`));
                }
                if (!change.removed) lineNumber++;
            });
        });
    }

    private outputSideBySideDiff(result: DiffResult): void {
        // Simple side-by-side implementation
        const terminalWidth = process.stdout.columns || 80;
        const columnWidth = Math.floor((terminalWidth - 3) / 2);
        
        console.log(chalk.gray(`${"─".repeat(columnWidth)} │ ${"─".repeat(columnWidth)}`));
        console.log(chalk.bold(`${this.version1.padEnd(columnWidth)} │ ${this.version2}`));
        console.log(chalk.gray(`${"─".repeat(columnWidth)} │ ${"─".repeat(columnWidth)}`));

        // This is a simplified version - for a full implementation, 
        // you'd want to properly align the changes side by side
        result.changes?.forEach(change => {
            const lines = change.value.split('\n').filter(line => line !== '');
            lines.forEach(line => {
                const truncatedLine = line.substring(0, columnWidth - 2);
                if (change.added) {
                    console.log(`${" ".repeat(columnWidth)} │ ${chalk.green("+ " + truncatedLine)}`);
                } else if (change.removed) {
                    console.log(`${chalk.red("- " + truncatedLine.padEnd(columnWidth - 2))} │`);
                } else {
                    console.log(`${chalk.gray("  " + truncatedLine.padEnd(columnWidth - 2))} │ ${chalk.gray("  " + truncatedLine)}`);
                }
            });
        });
    }

    private isDeltaAvailable(): boolean {
        try {
            execSync('which delta', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    private outputWithDelta(result: DiffResult): void {
        if (result.patch) {
            const tempFile = path.join(os.tmpdir(), `npm-diff-${Date.now()}.patch`);
            fs.writeFileSync(tempFile, result.patch);
            
            const theme = this.options.deltaTheme || 'auto';
            const deltaCmd = `delta --file-style=bold --hunk-header-style=file --theme=${theme} < ${tempFile}`;
            
            try {
                execSync(deltaCmd, { stdio: 'inherit' });
            } catch (e) {
                logger.warn("Delta failed, falling back to default output");
                this.outputTerminalDiff(result);
            } finally {
                fs.unlinkSync(tempFile);
            }
        }
    }

    private generateUnifiedDiff(): string {
        let unifiedDiff = "";
        this.results.forEach(result => {
            if (result.patch) {
                unifiedDiff += result.patch + "\n";
            }
        });
        return unifiedDiff;
    }

    private generateHtmlOutput(): string {
        try {
            const Diff2Html = require("diff2html");
            const unifiedDiff = this.generateUnifiedDiff();
            
            const html = Diff2Html.html(unifiedDiff, {
                drawFileList: true,
                matching: "lines",
                outputFormat: this.options.sideBySide ? "side-by-side" : "line-by-line",
                highlightCode: true
            });

            const template = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NPM Package Diff: ${this.packageName} ${this.version1} vs ${this.version2}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/diff2html/3.4.35/bundles/css/diff2html.min.css">
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }
        .header {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 { margin: 0; color: #333; }
        .meta { color: #666; margin-top: 10px; }
        .stats { margin-top: 15px; }
        .stat { 
            display: inline-block; 
            margin-right: 20px;
            padding: 5px 10px;
            background: #f0f0f0;
            border-radius: 4px;
        }
        .diff-wrapper {
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>NPM Package Diff Report</h1>
        <div class="meta">
            <strong>Package:</strong> ${this.packageName}<br>
            <strong>Versions:</strong> ${this.version1} → ${this.version2}<br>
            <strong>Generated:</strong> ${new Date().toLocaleString()}
        </div>
        <div class="stats">
            <span class="stat">📊 Files Changed: ${this.results.filter(r => r.status === "modified").length}</span>
            <span class="stat">➕ Files Added: ${this.results.filter(r => r.status === "added").length}</span>
            <span class="stat">➖ Files Removed: ${this.results.filter(r => r.status === "removed").length}</span>
        </div>
    </div>
    <div class="diff-wrapper">
        ${html}
    </div>
</body>
</html>`;
            return template;
        } catch (e) {
            logger.error("Failed to generate HTML output. Install diff2html: npm install diff2html");
            return "";
        }
    }

    private generateJsonOutput(): string {
        const summary = {
            package: this.packageName,
            version1: this.version1,
            version2: this.version2,
            timestamp: new Date().toISOString(),
            filter: this.options.filter,
            stats: {
                total: this.results.length,
                added: this.results.filter(r => r.status === "added").length,
                removed: this.results.filter(r => r.status === "removed").length,
                modified: this.results.filter(r => r.status === "modified").length,
                identical: this.results.filter(r => r.status === "identical").length
            },
            files: this.results.map(r => ({
                ...r,
                changes: undefined, // Remove the raw changes array for cleaner JSON
                patch: this.options.includePatchInJson ? r.patch : undefined
            }))
        };
        return JSON.stringify(summary, null, 2);
    }

    async outputResults(): Promise<void> {
        const format = this.options.format.toLowerCase();
        let output = "";

        switch (format) {
            case "unified":
            case "patch":
                output = this.generateUnifiedDiff();
                break;
            case "html":
                output = this.generateHtmlOutput();
                break;
            case "json":
                output = this.generateJsonOutput();
                break;
            case "side-by-side":
                this.options.sideBySide = true;
                // Fall through to terminal
            case "terminal":
            default:
                // Terminal output is handled differently
                break;
        }

        // Handle file output
        if (this.options.output || this.options.patch) {
            const outputPath = this.options.output || this.options.patch;
            fs.writeFileSync(outputPath, output);
            logger.success(`Output written to: ${outputPath}`);
        } else if (format !== "terminal" && format !== "side-by-side") {
            // For non-terminal formats, output to stdout
            console.log(output);
        }

        // Terminal output
        if ((format === "terminal" || format === "side-by-side") && !this.options.output) {
            this.results
                .filter(r => r.status !== "identical" || this.options.showIdentical)
                .forEach(result => this.outputTerminalDiff(result));
        }

        // Show statistics if requested
        if (this.options.stats) {
            this.showStatistics();
        }

        // Show size comparison if requested
        if (this.options.sizes) {
            this.showSizeComparison();
        }
    }

    private showStatistics(): void {
        const stats = {
            total: this.results.length,
            added: this.results.filter(r => r.status === "added").length,
            removed: this.results.filter(r => r.status === "removed").length,
            modified: this.results.filter(r => r.status === "modified").length,
            identical: this.results.filter(r => r.status === "identical").length
        };

        const statsBox = boxen(
            `${chalk.bold("📊 Diff Statistics")}\n\n` +
            `Total files analyzed: ${chalk.cyan(stats.total)}\n` +
            `Files added: ${chalk.green(`+${stats.added}`)}\n` +
            `Files removed: ${chalk.red(`-${stats.removed}`)}\n` +
            `Files modified: ${chalk.yellow(`~${stats.modified}`)}\n` +
            `Files unchanged: ${chalk.gray(stats.identical)}`,
            {
                padding: 1,
                margin: 1,
                borderStyle: "round",
                borderColor: "cyan"
            }
        );
        console.log(statsBox);
    }

    private showSizeComparison(): void {
        const table = new Table({
            head: ["File", "Status", `Size (${this.version1})`, `Size (${this.version2})`, "Diff"],
            style: { head: ["cyan"] }
        });

        this.results
            .filter(r => r.status !== "identical")
            .forEach(result => {
                const oldSize = result.oldSize ? filesize(result.oldSize) : "-";
                const newSize = result.newSize ? filesize(result.newSize) : "-";
                const sizeDiff = (result.oldSize && result.newSize) 
                    ? filesize(result.newSize - result.oldSize, { signed: true })
                    : "-";

                const status = {
                    added: chalk.green("Added"),
                    removed: chalk.red("Removed"),
                    modified: chalk.yellow("Modified"),
                    identical: chalk.gray("Identical")
                }[result.status];

                table.push([
                    result.file,
                    status,
                    oldSize,
                    newSize,
                    sizeDiff
                ]);
            });

        console.log("\n" + table.toString());
    }

    async cleanup(): Promise<void> {
        if (!this.options.keepTemp) {
            const cleanupSpinner = ora({
                text: "Cleaning up temporary files...",
                spinner: "dots"
            }).start();

            // Close watchers
            for (const watcher of this.watchers) {
                await watcher.close();
            }

            // Remove temp directory
            if (fs.existsSync(this.tempDir)) {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            }

            cleanupSpinner.succeed("Cleanup completed");
        } else {
            logger.info(`Temporary files kept at: ${this.tempDir}`);
        }
    }
}

async function main(): Promise<void> {
    const comparison = new EnhancedPackageComparison(packageName, version1, version2, config);

    try {
        await comparison.setup();
        await comparison.installPackages();
        await comparison.compareFiles();
        await comparison.outputResults();
    } catch (error) {
        logger.error(`Comparison failed: ${error}`);
        process.exit(1);
    } finally {
        await comparison.cleanup();
    }
}

// Handle process termination
process.on("SIGINT", async () => {
    logger.warn("\nProcess interrupted, cleaning up...");
    process.exit(0);
});

process.on("SIGTERM", async () => {
    logger.warn("\nProcess terminated, cleaning up...");
    process.exit(0);
});

// Start the application
main().catch((error) => {
    logger.error(`Fatal error: ${error}`);
    process.exit(1);
});