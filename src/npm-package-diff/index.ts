import chokidar from "chokidar";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import chalk from "chalk";
import { spawn } from "child_process";
import * as diff from "diff";
import { minimatch } from "minimatch";
import ora, { type Ora } from "ora";
import Table from "cli-table3";
import { filesize } from "filesize";
import boxen from "boxen";
import { createRequire } from "module";
import { execSync } from "child_process";
import { resolvePathWithTilde } from "@app/utils";

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
                    console.log(msg.replace(/\u001b\[[0-9;]*m/g, ""));
                }
            }
        },
        error: (msg: string) => {
            if (isTTY) {
                console.error(msg);
            } else {
                console.error(msg.replace(/\u001b\[[0-9;]*m/g, ""));
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
        },
    };
};

const logger = createSimpleLogger();

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

const program = new Command()
    .name("npm-package-diff")
    .argument("<package-name>", "Package name")
    .argument("<version1>", "First version")
    .argument("<version2>", "Second version")
    .option("-v, --verbose", "Enable verbose logging")
    .option("-f, --filter <pattern>", "Glob pattern to filter files", "**/*.d.ts")
    .option("-h, --help-old", "Show this help message")
    .option("-o, --output <file>", "Output file path")
    .option("-F, --format <format>", "Output format: terminal, unified, html, json, side-by-side", "terminal")
    .option("-e, --exclude <pattern>", "Glob pattern to exclude files")
    .option("-p, --patch <file>", "Generate patch file")
    .option("-c, --config <path>", "Path to config file")
    .option("-s, --silent", "Suppress all output except errors")
    .option("-m, --package-manager <manager>", "Package manager: auto, npm, yarn, pnpm, bun", "auto")
    .option("-k, --keep", "Keep temporary directories after comparison")
    .option("--stats", "Show statistics summary")
    .option("--sizes", "Compare file sizes")
    .option("--line-numbers", "Show line numbers", true)
    .option("--word-diff", "Show word-level differences")
    .option("--use-delta", "Use delta for terminal output (if installed)")
    .option("--paging", "Enable terminal pagination with color support")
    .option("--delta-theme <theme>", "Delta theme to use (light/dark)")
    .option("--npmrc <path>", "Path to .npmrc file for authentication")
    .option("--timeout <ms>", "Installation timeout in ms", "120000")
    .option("--context <lines>", "Number of context lines", "10")
    .parse();

const options = program.opts();
const [packageName, version1, version2] = program.args;

const fileConfig = loadConfig(options.config);

function getOptionValue<K extends keyof typeof options>(key: K): (typeof options)[K] {
    const source = program.getOptionValueSource(key);
    if (source === "default" && key in fileConfig) {
        return fileConfig[key as keyof typeof fileConfig] as (typeof options)[K];
    }
    return options[key];
}

const config = {
    ...options,
    filter: getOptionValue("filter"),
    format: getOptionValue("format"),
    packageManager: getOptionValue("packageManager"),
    timeout: getOptionValue("timeout"),
    context: getOptionValue("context"),
    lineNumbers: getOptionValue("lineNumbers"),
    exclude: getOptionValue("exclude"),
    output: getOptionValue("output"),
    patch: getOptionValue("patch"),
    verbose: getOptionValue("verbose"),
    silent: getOptionValue("silent"),
    keep: getOptionValue("keep"),
    stats: getOptionValue("stats"),
    sizes: getOptionValue("sizes"),
    wordDiff: getOptionValue("wordDiff"),
    useDelta: getOptionValue("useDelta"),
    paging: getOptionValue("paging"),
    deltaTheme: getOptionValue("deltaTheme"),
    npmrc: getOptionValue("npmrc"),
    includePatchInJson: false,
    showIdentical: false,
    helpOld: options.helpOld,
    _: [packageName, version1, version2],
};

if (config.helpOld) {
    const helpText = `
${boxen(chalk.bold.cyan("NPM Package Diff"), {
    padding: 1,
    margin: 1,
    borderStyle: "round",
    borderColor: "cyan",
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
  ${chalk.cyan("--context")}            Number of context lines (default: 10)
  ${chalk.cyan("--config, -c")}         Path to config file (default: .npmpackagediffrc)
  ${chalk.cyan("--use-delta")}          Use delta for terminal output (if installed)
  ${chalk.cyan("--delta-theme")}        Delta theme to use (light/dark)
  ${chalk.cyan("--timeout")}            Installation timeout in ms (default: 120000)
  ${chalk.cyan("--npmrc")}              Path to .npmrc file for authentication
  ${chalk.cyan("--package-manager")}    Package manager: auto, npm, yarn, pnpm, bun
                       (default: "auto")
  ${chalk.cyan("--paging")}             Enable terminal pagination with color support
  ${chalk.cyan("--keep, -k")}           Keep temporary directories after comparison

${chalk.bold("OUTPUT FORMATS:")}
  ${chalk.yellow("terminal")}       - Colored diff in terminal (default)
  ${chalk.yellow("unified")}        - Unified diff format (can be used as .patch)
  ${chalk.yellow("html")}           - Interactive HTML with side-by-side/line-by-line toggle
  ${chalk.yellow("json")}           - JSON format with detailed changes
  ${chalk.yellow("side-by-side")}   - Side-by-side comparison in terminal

${chalk.bold("EXAMPLES:")}
  ${chalk.gray("# Basic usage with TypeScript definitions")}
  npm-package-diff react 18.0.0 18.2.0

  ${chalk.gray("# Compare all JavaScript files")}
  npm-package-diff lodash 4.17.20 4.17.21 --filter="**/*.js"

  ${chalk.gray("# Generate a patch file")}
  npm-package-diff express 4.17.0 4.18.0 --patch express.patch

  ${chalk.gray("# Create interactive HTML report")}
  npm-package-diff @types/node 18.0.0 20.0.0 --format html -o report.html

  ${chalk.gray("# Show side-by-side diff with statistics")}
  npm-package-diff axios 0.27.0 1.0.0 --format side-by-side --stats

  ${chalk.gray("# Use delta for beautiful terminal output")}
  npm-package-diff typescript 4.9.0 5.0.0 --use-delta

  ${chalk.gray("# Use specific package manager with custom .npmrc")}
  npm-package-diff @private/package 1.0.0 2.0.0 --package-manager pnpm --npmrc ~/.npmrc

  ${chalk.gray("# Enable pagination for large diffs")}
  npm-package-diff large-package 1.0.0 2.0.0 --paging

  ${chalk.gray("# Keep temporary files for inspection")}
  npm-package-diff some-package 1.0.0 2.0.0 --keep

${chalk.bold("CONFIG FILE EXAMPLE (.npmpackagediffrc):")}
${chalk.gray(`{
  "filter": "**/*.{js,ts,jsx,tsx}",
  "exclude": "**/{test,tests,__tests__}/**",
  "format": "terminal",
  "lineNumbers": true,
  "wordDiff": false,
  "context": 10,
  "stats": true,
  "sizes": true,
  "timeout": 180000,
  "packageManager": "pnpm",
  "npmrc": "./.npmrc",
  "paging": true,
  "useDelta": false
}`)}
`;
    logger.info(helpText);
    process.exit(0);
}

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
    private spinner?: Ora;
    private results: DiffResult[] = [];
    private packageManager: PackageManager;
    private pagerProcess?: any;
    private outputBuffer: string[] = [];

    constructor(
        private packageName: string,
        private version1: string,
        private version2: string,
        private options: typeof config
    ) {
        this.tempDir = path.join(os.tmpdir(), `npm-diff-${packageName.replace(/[^a-zA-Z0-9]/g, "-")}`);
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
            execSync("which pnpm", { stdio: "ignore" });
            logger.debug("Using pnpm (found in PATH)");
            return "pnpm";
        } catch {}

        try {
            execSync("which bun", { stdio: "ignore" });
            logger.debug("Using bun (found in PATH)");
            return "bun";
        } catch {}

        try {
            execSync("which yarn", { stdio: "ignore" });
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
                spinner: "dots",
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
            const npmrcPath = resolvePathWithTilde(this.options.npmrc);

            if (fs.existsSync(npmrcPath)) {
                try {
                    const npmrcContent = fs.readFileSync(npmrcPath, "utf8");
                    fs.writeFileSync(path.join(this.dir1, ".npmrc"), npmrcContent);
                    fs.writeFileSync(path.join(this.dir2, ".npmrc"), npmrcContent);
                    logger.debug(`\nCopied .npmrc from ${npmrcPath}`);
                } catch (error) {
                    logger.error(`\nError copying .npmrc from ${npmrcPath}: ${error}`);
                }
            } else {
                logger.warn(`\nSpecified .npmrc file not found: ${npmrcPath}`);
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
                spinner: "dots",
            }).start();
        }

        // Setup watchers before installation
        this.setupWatcher(this.dir1, this.addedFiles1);
        this.setupWatcher(this.dir2, this.addedFiles2);

        // Give watchers time to initialize
        await new Promise((resolve) => setTimeout(resolve, 500));

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
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    private async installPackageInDirectory(pkg: string, version: string, dir: string): Promise<void> {
        logger.debug(`Installing ${pkg}@${version} in ${dir} using ${this.packageManager}`);

        const sanitizePackageName = (name: string): string => {
            return name.replace(/[^\w-]/g, "-").replace(/^@/, "");
        };

        const sanitizedPkgName = sanitizePackageName(pkg);

        // Initialize package.json
        const packageJson = {
            name: `temp-${sanitizedPkgName}-${version}`,
            version: "1.0.0",
            dependencies: {
                [pkg]: version,
            },
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
                installProcess.kill("SIGTERM");
                reject(new Error(`Installation timed out after ${this.options.timeout}ms for ${pkg}@${version}`));
            }, this.options.timeout);

            installProcess.on("close", (code) => {
                clearTimeout(timeout);
                if (timedOut) return;

                if (code === 0) {
                    logger.debug(`Successfully installed ${pkg}@${version} to ${dir}`);
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
        // Check delta availability first if requested
        if (this.options.useDelta && !this.isDeltaAvailable()) {
            logger.error(
                chalk.yellow(
                    "\n⚠️  Delta is not installed but --use-delta was specified.\n" +
                        "   To install delta for beautiful diffs:\n" +
                        "   • macOS: brew install git-delta\n" +
                        "   • Linux: Download from https://github.com/dandavison/delta/releases\n" +
                        "   • Cargo: cargo install git-delta\n"
                )
            );
            process.exit(1);
        }

        if (!this.options.silent) {
            this.spinner = ora({
                text: `Comparing files...`,
                spinner: "dots",
            }).start();
        }

        // Filter files based on the glob pattern
        const filteredFiles1 = this.addedFiles1.filter((file) => this.matchesFilter(file.relativePath));
        const filteredFiles2 = this.addedFiles2.filter((file) => this.matchesFilter(file.relativePath));

        logger.debug(`Found ${filteredFiles1.length} matching files in ${this.version1}`);
        logger.debug(`Found ${filteredFiles2.length} matching files in ${this.version2}`);

        // Create maps for easier lookup
        const files1Map = new Map(filteredFiles1.map((f) => [f.relativePath, f]));
        const files2Map = new Map(filteredFiles2.map((f) => [f.relativePath, f]));

        // Get all unique file paths
        const allPaths = new Set([...files1Map.keys(), ...files2Map.keys()]);

        for (const filePath of Array.from(allPaths).sort()) {
            const file1 = files1Map.get(filePath);
            const file2 = files2Map.get(filePath);

            if (file1 && file2) {
                await this.compareTwoFiles(file1, file2);
            } else if (file1 && !file2) {
                // For removed files, read the content and create a diff showing all lines as deletions
                try {
                    const content1 = fs.readFileSync(file1.absolutePath, "utf8");
                    const lines = content1.split("\n");
                    // Remove last empty line if present
                    if (lines[lines.length - 1] === "") {
                        lines.pop();
                    }
                    const lineCount = lines.length;

                    const changes = [{ removed: true, added: false, value: content1, count: lineCount }];

                    // Generate patch for removed file
                    const patch = diff.createTwoFilesPatch(
                        filePath,
                        filePath,
                        content1,
                        "",
                        `v${this.version1}`,
                        `v${this.version2}`,
                        { context: this.options.context }
                    );

                    this.results.push({
                        file: filePath,
                        status: "removed",
                        oldSize: file1.size,
                        additions: 0,
                        deletions: lineCount,
                        changes,
                        patch,
                    });
                } catch (error) {
                    logger.error(`Error reading removed file ${filePath}: ${error}`);
                    this.results.push({
                        file: filePath,
                        status: "removed",
                        oldSize: file1.size,
                    });
                }
            } else if (!file1 && file2) {
                // For added files, read the content and create a diff showing all lines as additions
                try {
                    const content2 = fs.readFileSync(file2.absolutePath, "utf8");
                    const lines = content2.split("\n");
                    // Remove last empty line if present
                    if (lines[lines.length - 1] === "") {
                        lines.pop();
                    }
                    const lineCount = lines.length;

                    const changes = [{ added: true, removed: false, value: content2, count: lineCount }];

                    // Generate patch for added file
                    const patch = diff.createTwoFilesPatch(
                        filePath,
                        filePath,
                        "",
                        content2,
                        `v${this.version1}`,
                        `v${this.version2}`,
                        { context: this.options.context }
                    );

                    this.results.push({
                        file: filePath,
                        status: "added",
                        newSize: file2.size,
                        additions: lineCount,
                        deletions: 0,
                        changes,
                        patch,
                    });
                } catch (error) {
                    logger.error(`Error reading added file ${filePath}: ${error}`);
                    this.results.push({
                        file: filePath,
                        status: "added",
                        newSize: file2.size,
                    });
                }
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
                    newSize: file2.size,
                });
                return;
            }

            // Generate diff
            const changes = this.options.wordDiff
                ? diff.diffWords(content1, content2)
                : diff.diffLines(content1, content2, {
                      ignoreWhitespace: false,
                      newlineIsToken: true,
                  });

            // Count additions and deletions
            let additions = 0;
            let deletions = 0;
            changes.forEach((change) => {
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
                patch,
            });
        } catch (error) {
            logger.error(`Error comparing files ${file1.relativePath}: ${error}`);
        }
    }

    private write(text: string): void {
        if (
            this.options.paging &&
            !this.options.output &&
            (this.options.format === "terminal" || this.options.format === "side-by-side")
        ) {
            this.outputBuffer.push(text);
        } else {
            console.log(text);
        }
    }

    private startPager(): void {
        if (
            !this.options.paging ||
            this.options.output ||
            (this.options.format !== "terminal" && this.options.format !== "side-by-side")
        ) {
            return;
        }

        try {
            // Use less with -R flag to preserve colors
            this.pagerProcess = spawn("less", ["-R", "-F", "-X"], {
                stdio: ["pipe", "inherit", "inherit"],
            });

            this.pagerProcess.on("error", (err: any) => {
                logger.debug(`Failed to start pager: ${err}`);
                // Fallback to normal output
                this.outputBuffer.forEach((line) => console.log(line));
                this.outputBuffer = [];
            });

            // Write buffered output to pager
            this.outputBuffer.forEach((line) => {
                this.pagerProcess.stdin.write(line + "\n");
            });
            this.outputBuffer = [];
        } catch (e) {
            // Fallback to normal output
            this.outputBuffer.forEach((line) => console.log(line));
            this.outputBuffer = [];
        }
    }

    private endPager(): void {
        if (this.pagerProcess && this.pagerProcess.stdin) {
            this.pagerProcess.stdin.end();
        }
    }

    private outputTerminalDiff(result: DiffResult): void {
        if (this.options.useDelta && this.isDeltaAvailable()) {
            this.outputWithDelta(result);
            return;
        }

        this.write(chalk.cyan(`\n${"=".repeat(80)}`));
        this.write(chalk.bold.white(`📄 ${result.file}`));

        if (result.status === "added") {
            this.write(chalk.green(`   Status: Added (${filesize(result.newSize || 0)})`));
        } else if (result.status === "removed") {
            this.write(chalk.red(`   Status: Removed (${filesize(result.oldSize || 0)})`));
        } else if (result.status === "modified") {
            this.write(chalk.yellow(`   Status: Modified`));
            this.write(chalk.gray(`   Size: ${filesize(result.oldSize || 0)} → ${filesize(result.newSize || 0)}`));
            this.write(
                chalk.green(`   +${result.additions} additions`) + " " + chalk.red(`-${result.deletions} deletions`)
            );
        }
        this.write(chalk.cyan(`${"=".repeat(80)}`));

        if (
            result.changes &&
            (result.status === "modified" || result.status === "added" || result.status === "removed")
        ) {
            if (this.options.format === "side-by-side") {
                this.outputSideBySideDiff(result);
            } else {
                this.outputInlineDiff(result);
            }
        }
    }

    private outputInlineDiff(result: DiffResult): void {
        const context = this.options.context;
        let outputLines: { type: "add" | "remove" | "normal"; content: string; lineNum?: number }[] = [];
        let lineNumberOld = 1;
        let lineNumberNew = 1;

        // Build a complete view of the file with changes
        result.changes?.forEach((change) => {
            const lines = change.value.split("\n");
            // Remove last empty line if the change doesn't end with newline
            if (lines[lines.length - 1] === "" && !change.value.endsWith("\n")) {
                lines.pop();
            }

            lines.forEach((line) => {
                if (change.added) {
                    outputLines.push({ type: "add", content: line, lineNum: lineNumberNew++ });
                } else if (change.removed) {
                    outputLines.push({ type: "remove", content: line, lineNum: lineNumberOld++ });
                } else {
                    outputLines.push({ type: "normal", content: line, lineNum: lineNumberOld });
                    lineNumberOld++;
                    lineNumberNew++;
                }
            });
        });

        // Output with context
        let i = 0;
        let lastPrintedIdx = -1;
        let hasOutput = false;

        while (i < outputLines.length) {
            const line = outputLines[i];

            if (line.type !== "normal") {
                // We found a change, print context before
                const startIdx = Math.max(lastPrintedIdx + 1, i - context);

                // Add separator if there's a gap
                if (lastPrintedIdx >= 0 && startIdx > lastPrintedIdx + 1) {
                    this.write(chalk.cyan(`   @@ ... @@`));
                }

                // Print context before
                for (let j = startIdx; j < i; j++) {
                    const contextLine = outputLines[j];
                    if (contextLine.type === "normal") {
                        const lineNum = this.options.lineNumbers
                            ? chalk.gray(` ${contextLine.lineNum?.toString().padStart(4)} `)
                            : "";
                        this.write(chalk.gray(`${lineNum}  ${contextLine.content}`));
                        hasOutput = true;
                    }
                }

                // Print all consecutive changes
                let j = i;
                while (j < outputLines.length && outputLines[j].type !== "normal") {
                    const changeLine = outputLines[j];
                    if (changeLine.type === "add") {
                        const lineNum = this.options.lineNumbers
                            ? chalk.green(` ${changeLine.lineNum?.toString().padStart(4)} `)
                            : "";
                        this.write(chalk.green(`${lineNum}+ ${changeLine.content}`));
                    } else if (changeLine.type === "remove") {
                        const lineNum = this.options.lineNumbers
                            ? chalk.red(` ${changeLine.lineNum?.toString().padStart(4)} `)
                            : "";
                        this.write(chalk.red(`${lineNum}- ${changeLine.content}`));
                    }
                    hasOutput = true;
                    j++;
                }

                // Print context after
                const endIdx = Math.min(j + context, outputLines.length);
                for (let k = j; k < endIdx; k++) {
                    const contextLine = outputLines[k];
                    if (contextLine.type === "normal") {
                        const lineNum = this.options.lineNumbers
                            ? chalk.gray(` ${contextLine.lineNum?.toString().padStart(4)} `)
                            : "";
                        this.write(chalk.gray(`${lineNum}  ${contextLine.content}`));
                        hasOutput = true;
                    }
                }

                lastPrintedIdx = endIdx - 1;
                i = endIdx;
            } else {
                i++;
            }
        }

        // If no output was generated (e.g., all changes are beyond context), show a message
        if (!hasOutput && result.changes && result.changes.length > 0) {
            this.write(chalk.gray(`   [Changes exist but are outside the context of ${context} lines]`));
        }
    }

    private outputSideBySideDiff(result: DiffResult): void {
        // Simple side-by-side implementation
        const terminalWidth = process.stdout.columns || 80;
        const columnWidth = Math.floor((terminalWidth - 3) / 2);

        this.write(chalk.gray(`${"─".repeat(columnWidth)} │ ${"─".repeat(columnWidth)}`));
        this.write(chalk.bold(`${this.version1.padEnd(columnWidth)} │ ${this.version2}`));
        this.write(chalk.gray(`${"─".repeat(columnWidth)} │ ${"─".repeat(columnWidth)}`));

        // This is a simplified version with context support
        const context = this.options.context;
        let contextBuffer: string[] = [];
        let inChange = false;
        let hasOutput = false;

        result.changes?.forEach((change, idx) => {
            const lines = change.value.split("\n");
            if (lines[lines.length - 1] === "" && !change.value.endsWith("\n")) {
                lines.pop();
            }

            if (change.added || change.removed) {
                // Output context before if we have any
                if (contextBuffer.length > 0) {
                    const startIdx = Math.max(0, contextBuffer.length - context);
                    if (inChange && startIdx > 0) {
                        this.write(chalk.cyan(`${"...".padEnd(columnWidth)} │ ${"...".padEnd(columnWidth)}`));
                    }
                    for (let i = startIdx; i < contextBuffer.length; i++) {
                        const line = contextBuffer[i];
                        const truncated = line.substring(0, columnWidth - 2);
                        this.write(
                            `${chalk.gray("  " + truncated.padEnd(columnWidth - 2))} │ ${chalk.gray("  " + truncated)}`
                        );
                        hasOutput = true;
                    }
                }
                contextBuffer = [];
                inChange = true;

                lines.forEach((line) => {
                    const truncatedLine = line.substring(0, columnWidth - 2);
                    if (change.added) {
                        this.write(`${" ".repeat(columnWidth)} │ ${chalk.green("+ " + truncatedLine)}`);
                    } else if (change.removed) {
                        this.write(`${chalk.red("- " + truncatedLine.padEnd(columnWidth - 2))} │`);
                    }
                    hasOutput = true;
                });
            } else {
                // Normal lines
                if (inChange) {
                    // Show context after changes
                    lines.slice(0, context).forEach((line) => {
                        const truncated = line.substring(0, columnWidth - 2);
                        this.write(
                            `${chalk.gray("  " + truncated.padEnd(columnWidth - 2))} │ ${chalk.gray("  " + truncated)}`
                        );
                        hasOutput = true;
                    });
                    inChange = false;
                    contextBuffer = lines.slice(context);
                } else {
                    // Buffer context lines
                    contextBuffer = contextBuffer.concat(lines);
                    if (contextBuffer.length > context * 2) {
                        contextBuffer = contextBuffer.slice(-context);
                    }
                }
            }
        });

        if (!hasOutput && result.changes && result.changes.length > 0) {
            this.write(chalk.gray(`   [Changes exist but are outside the context of ${context} lines]`));
        }
    }

    private isDeltaAvailable(): boolean {
        try {
            execSync("which delta", { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    }

    private outputWithDelta(result: DiffResult): void {
        if (result.patch) {
            const tempFile = path.join(os.tmpdir(), `npm-diff-${Date.now()}.patch`);
            fs.writeFileSync(tempFile, result.patch);

            const deltaCmd = `delta --file-style=bold --hunk-header-style=file < ${tempFile}`;

            try {
                execSync(deltaCmd, { stdio: "inherit" });
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
        this.results.forEach((result) => {
            if (result.patch) {
                unifiedDiff += result.patch + "\n";
            }
        });
        return unifiedDiff;
    }

    private generateHtmlOutput(): string {
        const unifiedDiff = this.generateUnifiedDiff();
        // Escape for JavaScript template literal (backticks and ${})
        const jsEscapedDiff = unifiedDiff
            .replace(/\\/g, "\\\\") // Escape backslashes first
            .replace(/`/g, "\\`") // Escape backticks
            .replace(/\$/g, "\\$"); // Escape dollar signs

        const template = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NPM Package Diff: ${this.packageName} ${this.version1} vs ${this.version2}</title>
    <script src="https://cdn.jsdelivr.net/npm/diff2html@3.4.51/bundles/js/diff2html-ui.min.js"></script>
    <link href="https://cdn.jsdelivr.net/npm/diff2html@3.4.51/bundles/css/diff2html.min.css" rel="stylesheet">
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
        .controls {
            background: white;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .controls button {
            padding: 8px 16px;
            margin-right: 10px;
            border: none;
            border-radius: 4px;
            background: #007bff;
            color: white;
            cursor: pointer;
            font-size: 14px;
        }
        .controls button:hover {
            background: #0056b3;
        }
        .controls button.active {
            background: #28a745;
        }
        .diff-wrapper {
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        #diff-container {
            padding: 20px;
        }
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
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
            <span class="stat">📊 Files Changed: ${this.results.filter((r) => r.status === "modified").length}</span>
            <span class="stat">➕ Files Added: ${this.results.filter((r) => r.status === "added").length}</span>
            <span class="stat">➖ Files Removed: ${this.results.filter((r) => r.status === "removed").length}</span>
        </div>
    </div>
    <script>
    let fileList = true;
    </script>
    <div class="controls">
        <button id="side-by-side-btn" onclick="switchToSideBySide()">Side by Side</button>
        <button id="line-by-line-btn" class="active" onclick="switchToLineByLine()">Line by Line</button>
    </div>
    
    <div class="diff-wrapper">
        <div id="diff-container">
            <div class="loading">Loading diff...</div>
        </div>
    </div>

    <script>
        // Store the unified diff in a variable
        const unifiedDiff = \`${jsEscapedDiff}\`;
        
        let currentView = 'line-by-line';
        let diff2htmlUi = null;
        
        function renderDiff(outputFormat) {
            const targetElement = document.getElementById('diff-container');
            targetElement.innerHTML = '<div class="loading">Rendering diff...</div>';
            
            // Use setTimeout to allow the loading message to show
            setTimeout(() => {
                diff2htmlUi = new Diff2HtmlUI(targetElement, unifiedDiff, {
                    drawFileList: true,
                    matching: 'lines',
                    outputFormat: outputFormat,
                    highlightCode: true,
                    fileListToggle: true,
                    fileContentToggle: true,
                    synchronisedScroll: true
                });
                
                diff2htmlUi.draw();
                diff2htmlUi.highlightCode();
                diff2htmlUi.fileListToggle(true);
                
                if (outputFormat === 'side-by-side') {
                    diff2htmlUi.synchronisedScroll();
                }
            }, 100);
        }
        
        function switchToSideBySide() {
            currentView = 'side-by-side';
            document.getElementById('side-by-side-btn').classList.add('active');
            document.getElementById('line-by-line-btn').classList.remove('active');
            renderDiff('side-by-side');
        }
        
        function switchToLineByLine() {
            currentView = 'line-by-line';
            document.getElementById('line-by-line-btn').classList.add('active');
            document.getElementById('side-by-side-btn').classList.remove('active');
            renderDiff('line-by-line');
        }
        
        function toggleFileList() {
            if (diff2htmlUi) {
                diff2htmlUi.fileListToggle(true);
            }
        }
        
        // Initial render
        document.addEventListener('DOMContentLoaded', function() {
            renderDiff('line-by-line');
        });
    </script>
</body>
</html>`;
        return template;
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
                added: this.results.filter((r) => r.status === "added").length,
                removed: this.results.filter((r) => r.status === "removed").length,
                modified: this.results.filter((r) => r.status === "modified").length,
                identical: this.results.filter((r) => r.status === "identical").length,
            },
            files: this.results.map((r) => ({
                ...r,
                changes: undefined, // Remove the raw changes array for cleaner JSON
                patch: this.options.includePatchInJson ? r.patch : undefined,
            })),
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
            // Start pager if needed
            if (this.options.paging) {
                this.outputBuffer = [];
            }

            this.results
                .filter((r) => r.status !== "identical" || this.options.showIdentical)
                .forEach((result) => this.outputTerminalDiff(result));

            // Show statistics if requested
            if (this.options.stats) {
                this.showStatistics();
            }

            // Show size comparison if requested
            if (this.options.sizes) {
                this.showSizeComparison();
            }

            // Start pager with all output
            if (this.options.paging) {
                this.startPager();
                this.endPager();
            }
        }
    }

    private showStatistics(): void {
        const stats = {
            total: this.results.length,
            added: this.results.filter((r) => r.status === "added").length,
            removed: this.results.filter((r) => r.status === "removed").length,
            modified: this.results.filter((r) => r.status === "modified").length,
            identical: this.results.filter((r) => r.status === "identical").length,
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
                borderColor: "cyan",
            }
        );
        this.write(statsBox);
    }

    private showSizeComparison(): void {
        const table = new Table({
            head: ["File", "Status", `Size (${this.version1})`, `Size (${this.version2})`, "Diff"],
            style: { head: ["cyan"] },
        });

        this.results
            .filter((r) => r.status !== "identical")
            .forEach((result) => {
                const oldSize = result.oldSize != null ? filesize(result.oldSize) : "-";
                const newSize = result.newSize != null ? filesize(result.newSize) : "-";
                let sizeDiff = "-";
                if (result.oldSize != null && result.newSize != null) {
                    const diff = result.newSize - result.oldSize;
                    const prefix = diff > 0 ? "+" : "";
                    sizeDiff = prefix + String(filesize(diff));
                }

                const status = {
                    added: chalk.green("Added"),
                    removed: chalk.red("Removed"),
                    modified: chalk.yellow("Modified"),
                    identical: chalk.gray("Identical"),
                }[result.status];

                table.push([result.file, status, String(oldSize), String(newSize), sizeDiff]);
            });

        this.write("\n" + table.toString());
    }

    async cleanup(): Promise<void> {
        if (!this.options.keep) {
            const cleanupSpinner = ora({
                text: "Cleaning up temporary files...",
                spinner: "dots",
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
        logger.error(`Comparison failed: ${error}. Try running with --verbose flag for more information.`);
        throw error;
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
