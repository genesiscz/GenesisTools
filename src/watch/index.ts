import { consoleLog as logger } from "@app/logger";
import { handleReadmeFlag } from "@app/utils/readme";
import chalk from "chalk";
import chokidar from "chokidar";
import { Command } from "commander";
import type { WatchEventType, WatchOptions } from "node:fs";
import fs from "node:fs";
import { glob } from "glob";
import os from "node:os";
import path from "node:path";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

const program = new Command()
    .name("watch")
    .description("Watch files matching a glob pattern and display changes in real-time")
    .argument("<pattern>", "Glob pattern to watch")
    .option("-s, --seconds <n>", "Polling interval in seconds for directory rescans", "1")
    .option("-v, --verbose", "Enable verbose logging", false)
    .option("-f, --follow", "Follow mode: continuously watch files for changes (like tail -f)", false)
    .option("-n, --lines <n>", "Number of lines to display from each file", "50")
    .parse();

const options = program.opts();
const args = program.args;

// Get the glob pattern from arguments
let globPatterns = args;
if (globPatterns.length === 0) {
    logger.error(chalk.red("Error: No glob pattern provided"));
    logger.info(chalk.yellow("Use --help for usage information"));
    process.exit(1);
}

// Check if shell expansion has likely occurred
let possibleShellExpansion = false;
for (const pattern of globPatterns) {
    // A pattern likely wasn't shell-expanded if it contains glob chars
    const hasGlobChars = /[*?[\]{}()]/.test(pattern);
    if (!hasGlobChars) {
        possibleShellExpansion = true;
        break;
    }
}

if (possibleShellExpansion) {
    logger.error(chalk.red("Error: It appears your glob patterns may have been expanded by the shell"));
    logger.info(chalk.yellow("To prevent this, please wrap each pattern in quotes:"));
    logger.info(chalk.green(`tools watch "src/**/*.ts"`));
    logger.info("");
    logger.info(chalk.blue("Without quotes, the shell expands wildcards before passing arguments to the script."));
    process.exit(1);
}

// Expand tilde to home directory in all patterns
globPatterns = globPatterns.map((pattern) => {
    if (pattern.startsWith("~/")) {
        return pattern.replace(/^~\//, `${os.homedir()}/`);
    }
    return pattern;
});

// Store current working directory
const cwd = process.cwd();

// For debug purposes
if (options.verbose) {
    logger.info(`CWD: ${cwd}`);
    logger.info(`Patterns: ${JSON.stringify(globPatterns)}`);
}

const log = {
    info: (message: string) => logger.info(chalk.blue("ℹ️ ") + message),
    debug: (message: string) => (options.verbose ? logger.info(chalk.gray("🔍 ") + message) : null),
    error: (message: string, err?: any) => logger.error(chalk.red("❌ ") + message + (err ? `: ${err}` : "")),
    warn: (message: string) => logger.info(chalk.yellow("⚠️ ") + message),
    file: {
        new: (filepath: string) => logger.info(chalk.green(`\n📄 NEW FILE: ${filepath}`)),
        existing: (filepath: string) => logger.info(chalk.blue(`\n📄 EXISTING FILE: ${filepath}`)),
        change: (filepath: string) => logger.info(chalk.yellow(`\n📝 UPDATED: ${filepath}`)),
        remove: (filepath: string) => logger.info(chalk.red(`\n🗑️  REMOVED: ${filepath}`)),
        content: (content: string) => {
            // Use a box with a distinct color for file content
            logger.info(chalk.cyan(`┌${"─".repeat(78)}┐`));

            // Split by lines and add a prefix to each line
            const lines = content.split("\n");
            for (const line of lines) {
                logger.info(chalk.cyan("│ ") + line);
            }

            logger.info(chalk.cyan(`└${"─".repeat(78)}┘`));
        },
    },
    summary: {
        directories: (dirs: Set<string>) => {
            logger.info(chalk.magenta("\n📁 WATCHED DIRECTORIES:"));
            Array.from(dirs)
                .sort()
                .forEach((dir) => {
                    logger.info(chalk.magenta("   ├─ ") + dir);
                });
        },
        files: (files: Set<string>) => {
            logger.info(chalk.green("\n📁 WATCHED FILES:"));
            Array.from(files)
                .sort()
                .forEach((file) => {
                    logger.info(chalk.green("   ├─ ") + file);
                });
        },
    },
};

log.info(`Watching files matching pattern: ${chalk.cyan(path.join(cwd, globPatterns.join(", ")).replace(/\\/g, "/"))}`);
log.info(`Base directory: ${chalk.cyan(cwd)}`);
log.info(`Directory rescan interval: ${chalk.yellow(options.seconds.toString())} seconds`);
log.info(`Lines to display: ${chalk.yellow(options.lines.toString())}`);
if (options.follow) {
    log.info("Follow mode enabled: continuously tailing files");
}
if (options.verbose) {
    log.info("Verbose logging enabled");
}

// Initialize the file tracking data
const filePositions: Record<string, number> = {};
const scannedDirectories = new Set<string>();
const matchedFiles = new Set<string>();
const fileLastModified: Record<string, number> = {}; // Track last modified time
let lastUpdatedFile: string | null = null; // Track the last updated file

// Helper function to read file content with a specified line limit
function readFileWithLineLimit(
    filepath: string,
    startPosition: number,
    fileSize: number,
    fd: number,
    lineLimit: number
): string {
    try {
        // If reading from a specific position (not the beginning), just read the new content
        if (startPosition > 0) {
            const bufferSize = fileSize - startPosition;
            const buffer = Buffer.alloc(bufferSize);
            fs.readSync(fd, buffer, 0, bufferSize, startPosition);
            return buffer.toString("utf8");
        }

        // If we need to limit lines and are starting from the beginning
        if (lineLimit > 0) {
            // Instead of reading the whole file, we'll read backwards in chunks
            // to find just the last N lines
            const chunkSize = 1024; // Read 1KB at a time
            const buffer = Buffer.alloc(chunkSize);
            let lines: string[] = [];
            let position = fileSize;
            let foundLines = 0;
            let remainder = "";

            // Read backwards in chunks until we have enough lines or reach beginning of file
            while (position > 0 && foundLines < lineLimit) {
                const size = Math.min(chunkSize, position);
                position -= size;

                // Read a chunk
                fs.readSync(fd, buffer, 0, size, position);

                // Convert to string and prepend any remainder from previous iteration
                const content = buffer.slice(0, size).toString("utf8") + remainder;

                // Split into lines and count them
                const chunk_lines = content.split("\n");

                // If this isn't the last chunk and the first line isn't a complete line,
                // save it as remainder for next iteration and remove it from current chunk
                if (position > 0 && chunk_lines.length > 1) {
                    remainder = chunk_lines[0];
                    chunk_lines.shift();
                }

                // Add lines to our result, but limit to what we need
                lines = [...chunk_lines, ...lines];
                foundLines = lines.length;

                // If we have more lines than needed, trim the excess
                if (foundLines > lineLimit) {
                    lines = lines.slice(-lineLimit);
                    break;
                }
            }

            return lines.join("\n");
        }

        // If no line limit, read the whole file
        const buffer = Buffer.alloc(fileSize);
        fs.readSync(fd, buffer, 0, fileSize, 0);
        return buffer.toString("utf8");
    } catch (err) {
        log.error(`Error reading file content: ${filepath}`, err);
        return "";
    }
}

// Define types for tailFile arguments
type TailFileOptions = {
    filepath: string;
    follow?: boolean;
    isInitialDisplay?: boolean;
};

// Helper function to read and display file content in tail -f style
function tailFile({ filepath, follow = false, isInitialDisplay = false }: TailFileOptions): void {
    try {
        log.debug(`Processing file: ${filepath}`);

        // Verify file exists and is readable
        if (!fs.existsSync(filepath)) {
            log.debug(`File does not exist: ${filepath}`);
            return;
        }

        const stats = fs.statSync(filepath);
        if (!stats.isFile()) {
            log.debug(`Not a file: ${filepath}`);
            return;
        }

        // Update file's last modified time
        fileLastModified[filepath] = stats.mtimeMs;

        // Get file descriptor
        const fd = fs.openSync(filepath, "r");

        // Determine the starting position for reading
        const isNewFile = !(filepath in filePositions);
        const startPosition = isNewFile ? (follow && !isInitialDisplay ? stats.size : 0) : filePositions[filepath];
        const fileSize = stats.size;

        // Track the file and its directory
        matchedFiles.add(filepath);
        const dirPath = path.dirname(filepath);
        scannedDirectories.add(dirPath);

        log.debug(`File size: ${fileSize}, Start position: ${startPosition}, Is new: ${isNewFile}`);

        // If there's new content
        if (fileSize > startPosition) {
            // Read the file content with line limit for non-follow mode
            const newContent = readFileWithLineLimit(
                filepath,
                startPosition,
                fileSize,
                fd,
                isNewFile || isInitialDisplay ? parseInt(options.lines.toString(), 10) : 0
            );

            // Format the last modified time
            const modifiedTime = new Date(stats.mtimeMs).toLocaleTimeString();

            // Display file information and new content
            if (isNewFile) {
                // If we're showing initial display, mark them as existing not new
                if (isInitialDisplay) {
                    log.file.existing(`${modifiedTime} - ${filepath}`);
                } else {
                    log.file.new(`${modifiedTime} - ${filepath}`);
                }
            } else {
                // Only show the UPDATED message if it's not the same file as the last update
                if (lastUpdatedFile !== filepath) {
                    log.file.change(`${modifiedTime} - ${filepath}`);
                }
            }

            // Set this as the last updated file
            lastUpdatedFile = filepath;

            // Display the content with formatting
            if (newContent.trim()) {
                log.file.content(newContent);
            }

            // Update the position for next read
            filePositions[filepath] = fileSize;
        } else {
            log.debug(`No new content for ${filepath}`);
        }

        // Close the file descriptor
        fs.closeSync(fd);
    } catch (err) {
        log.error(`Error reading file ${filepath}`, err);
    }
}

// Function to get files sorted by last modified time
function getSortedFilesByModTime(): string[] {
    return Object.entries(fileLastModified)
        .sort((a, b) => b[1] - a[1]) // Sort by last modified time, newest first
        .map((entry) => entry[0]); // Extract just the file paths
}

// Function to print scanned directories and files
function printScannedPaths() {
    log.summary.directories(scannedDirectories);
    log.summary.files(matchedFiles);
    logger.info(""); // Add empty line for better readability
}

// Function to scan for files matching the glob pattern
async function scanForFiles(): Promise<string[]> {
    log.debug(`Performing glob scan for: ${globPatterns.join(", ")} in ${cwd}`);

    try {
        const files = await Promise.all(
            globPatterns.map(async (pattern) => {
                const files = await glob(pattern, {
                    absolute: true,
                    dot: true,
                    nodir: true,
                    windowsPathsNoEscape: true,
                    cwd: cwd,
                });

                if (files.length === 0) {
                    log.debug(`No files found matching the pattern: ${pattern}`);
                } else {
                    log.debug(`Found ${files.length} files matching the pattern: ${pattern}`);
                }

                return files;
            })
        );

        const allFiles = files.flat();
        if (allFiles.length === 0) {
            log.debug("No files found matching the patterns");
        } else {
            log.debug(`Found ${allFiles.length} files matching the patterns`);
        }

        return allFiles;
    } catch (err) {
        log.error(`Error during file scan`, err);
        return [];
    }
}

// Process new files that aren't being tracked yet
function processNewFiles(files: string[]) {
    // In follow mode, we want to show the last n lines before following
    for (const file of files) {
        if (!matchedFiles.has(file)) {
            tailFile({ filepath: file, follow: true });
        }
    }
}

// Function to directly check for file changes (using fs.watch API)
async function setupFileWatchers() {
    try {
        // For each tracked file, set up a watcher for direct file changes
        Array.from(matchedFiles).forEach((file) => {
            try {
                fs.watch(file, { persistent: true } as WatchOptions, (eventType: WatchEventType) => {
                    if (eventType === "change") {
                        log.debug(`Direct fs.watch event (change) for ${file}`);
                        // Immediately check the file size and read new content
                        try {
                            if (fs.existsSync(file)) {
                                const stats = fs.statSync(file);
                                const currentSize = stats.size;
                                const trackedSize = filePositions[file] || 0;

                                if (currentSize > trackedSize) {
                                    // Update the file's last modified time
                                    fileLastModified[file] = stats.mtimeMs;
                                    tailFile({ filepath: file });
                                }
                            }
                        } catch (err) {
                            log.debug(`Error checking file ${file} after fs.watch event: ${err}`);
                        }
                    }
                });
            } catch (err) {
                log.debug(`Error setting up fs.watch for ${file}: ${err}`);
            }
        });
    } catch (err) {
        log.error(`Error in setupFileWatchers`, err);
    }
}

// Main function to watch files using both chokidar and direct FS watchers
async function startWatcher() {
    // Perform initial scan and setup
    log.info(chalk.cyan("Performing initial scan for existing files..."));
    const initialFiles = await scanForFiles();

    // If no files are found, exit with a message
    if (initialFiles.length === 0) {
        log.error("No files found matching the patterns. Exiting.");
        process.exit(1);
    }

    // First, update last modified times for all files and track their directories
    for (const file of initialFiles) {
        try {
            const stats = fs.statSync(file);
            fileLastModified[file] = stats.mtimeMs;
            // Also track directories
            const dirPath = path.dirname(file);
            scannedDirectories.add(dirPath);
            matchedFiles.add(file);
        } catch (err) {
            log.error(`Error getting stats for file ${file}`, err);
        }
    }

    // Display directory and file summaries first
    printScannedPaths();

    // Sort files by last modified time - always show oldest first in initial display
    // so most recently modified appears at the bottom of the screen
    // Get the sorted files, but reverse them to get oldest first
    const sortedFiles = getSortedFilesByModTime().reverse();

    // If not in follow mode, display content and exit
    if (!options.follow) {
        for (const file of sortedFiles) {
            tailFile({ filepath: file, follow: false, isInitialDisplay: true });
        }
        log.info(chalk.green("Finished displaying files. Exiting."));
        process.exit(0);
    }

    // In follow mode, display initial content in sorted order first
    for (const file of sortedFiles) {
        tailFile({ filepath: file, follow: true, isInitialDisplay: true });
    }

    // Set up direct FS watchers for instant file change detection
    await setupFileWatchers();

    // Configure chokidar options for maximum responsiveness
    const watchOptions = {
        persistent: true,
        ignoreInitial: true, // Already did initial scan
        usePolling: true,
        interval: 100, // Poll very frequently (100ms) for instant file updates
        followSymlinks: true,
        alwaysStat: true,
        awaitWriteFinish: {
            stabilityThreshold: 50, // Lower threshold for faster response
            pollInterval: 50,
        },
        disableGlobbing: true, // We handle globbing ourselves
    };

    log.info(chalk.cyan("Starting file watcher..."));

    // Start watching with chokidar - watch individual files and their parent directories
    const watcher = chokidar.watch(Array.from(matchedFiles), watchOptions);

    // Also watch immediate parent directories of matched files to detect new files quickly
    const parentDirs = Array.from(scannedDirectories);
    if (parentDirs.length > 0) {
        watcher.add(parentDirs);
    }

    // Set up chokidar event handlers
    watcher
        .on("add", (filepath) => {
            log.debug(`File added event: ${filepath}`);
            if (!matchedFiles.has(filepath)) {
                // Check if this file matches our glob pattern
                try {
                    const foundFiles = [];
                    for (const pattern of globPatterns) {
                        const matchedFiles = glob.sync(pattern, {
                            absolute: true,
                            dot: true,
                            nodir: true,
                            windowsPathsNoEscape: true,
                            cwd: cwd,
                        });
                        foundFiles.push(...matchedFiles);
                    }

                    if (foundFiles.includes(filepath)) {
                        // Update the file's last modified time
                        try {
                            const stats = fs.statSync(filepath);
                            fileLastModified[filepath] = stats.mtimeMs;
                        } catch (err) {
                            log.debug(`Error getting stats for new file ${filepath}: ${err}`);
                        }

                        tailFile({ filepath, follow: false });
                        // Set up direct watcher for this new file
                        try {
                            fs.watch(filepath, { persistent: true } as WatchOptions, (eventType: WatchEventType) => {
                                if (eventType === "change") {
                                    log.debug(`Direct fs.watch event (change) for ${filepath}`);

                                    // Update last modified time
                                    try {
                                        const stats = fs.statSync(filepath);
                                        fileLastModified[filepath] = stats.mtimeMs;
                                    } catch (err) {
                                        log.debug(`Error updating last modified time for ${filepath}: ${err}`);
                                    }

                                    tailFile({ filepath, follow: false });
                                }
                            });
                        } catch (err) {
                            log.debug(`Error setting up fs.watch for new file ${filepath}: ${err}`);
                        }
                    }
                } catch (err) {
                    log.error(`Error checking glob match`, err);
                }
            }
        })
        .on("change", (filepath) => {
            log.debug(`File changed event: ${filepath}`);
            if (matchedFiles.has(filepath)) {
                // Update last modified time
                try {
                    const stats = fs.statSync(filepath);
                    fileLastModified[filepath] = stats.mtimeMs;
                } catch (err) {
                    log.debug(`Error updating last modified time for ${filepath}: ${err}`);
                }

                // Immediately tail the file when a change is detected
                tailFile({ filepath, follow: false });
            }
        })
        .on("unlink", (filepath) => {
            if (matchedFiles.has(filepath)) {
                log.debug(`File removed event: ${filepath}`);
                log.file.remove(`${new Date().toLocaleTimeString()} - ${filepath}`);

                // Remove from tracking
                delete filePositions[filepath];
                delete fileLastModified[filepath];
                matchedFiles.delete(filepath);

                // Reset lastUpdatedFile if it was this file
                if (lastUpdatedFile === filepath) {
                    lastUpdatedFile = null;
                }

                // Check if directory is now empty
                const dirPath = path.dirname(filepath);
                const dirHasFiles = Array.from(matchedFiles).some((file) => path.dirname(file) === dirPath);
                if (!dirHasFiles) {
                    scannedDirectories.delete(dirPath);
                }
            }
        })
        .on("error", (error) => {
            log.error(`Watcher error`, error);
        })
        .on("ready", () => {
            log.info(chalk.green("Watcher initialized and ready"));
        });

    // Fallback check in case any file system events are missed
    const fileCheckInterval = setInterval(() => {
        Array.from(matchedFiles).forEach((file) => {
            try {
                if (fs.existsSync(file)) {
                    const stats = fs.statSync(file);
                    const currentSize = stats.size;
                    const trackedSize = filePositions[file] || 0;

                    if (currentSize > trackedSize) {
                        log.debug(
                            `File size change detected in interval check: ${file} (${trackedSize} -> ${currentSize})`
                        );
                        // Update last modified time
                        fileLastModified[file] = stats.mtimeMs;
                        tailFile({ filepath: file });
                    }
                }
            } catch (err) {
                log.debug(`Error checking file ${file}: ${err}`);
            }
        });
    }, 50); // Very frequent checks (50ms)

    // Periodically rescan to catch any new/changed files that may be missed
    const rescanInterval = setInterval(async () => {
        log.debug(`Performing periodic rescan for new files...`);

        try {
            // Scan for current matching files
            const currentFiles = await scanForFiles();

            // Check for new files
            if (currentFiles.length > matchedFiles.size) {
                // Filter only the new files
                const newFiles = currentFiles.filter((file) => !matchedFiles.has(file));
                if (newFiles.length > 0) {
                    log.debug(`Found ${newFiles.length} new file(s) during rescan`);
                }

                // Process new files
                processNewFiles(newFiles);

                // Update watcher with new files
                watcher.add(newFiles);

                // Update direct watchers for new files
                setupFileWatchers();

                // Update watcher with new directories if needed
                const newDirs = Array.from(scannedDirectories).filter((dir) => !parentDirs.includes(dir));
                if (newDirs.length > 0) {
                    watcher.add(newDirs);
                    parentDirs.push(...newDirs);
                }
            }

            // Check for deleted files
            const deletedFiles = Array.from(matchedFiles).filter((file) => !currentFiles.includes(file));
            if (deletedFiles.length > 0) {
                log.debug(`Detected ${deletedFiles.length} deleted file(s) during rescan`);

                deletedFiles.forEach((file) => {
                    log.debug(`File detected as deleted during rescan: ${file}`);

                    if (matchedFiles.has(file)) {
                        log.file.remove(`${new Date().toLocaleTimeString()} - ${file}`);
                        matchedFiles.delete(file);
                        delete filePositions[file];
                        delete fileLastModified[file];

                        // Reset lastUpdatedFile if it was this file
                        if (lastUpdatedFile === file) {
                            lastUpdatedFile = null;
                        }
                    }
                });
            }
        } catch (err) {
            log.error(`Error during rescan`, err);
        }
    }, parseInt(options.seconds, 10) * 1000);

    // Handle process termination
    process.on("SIGINT", () => {
        log.info(chalk.yellow("Stopping file watcher..."));
        clearInterval(fileCheckInterval);
        clearInterval(rescanInterval);
        watcher.close().then(() => process.exit(0));
    });

    log.info(chalk.green("Watch-glob is running. Press Ctrl+C to stop."));
}

// Start the application
startWatcher();
