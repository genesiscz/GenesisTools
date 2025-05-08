import chokidar from 'chokidar';
import minimist from 'minimist';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { glob } from 'glob';
import logger from '../logger';
import chalk from 'chalk';

const argv = minimist(process.argv.slice(2), {
    alias: { 
        s: 'seconds', 
        v: 'verbose',
        f: 'follow'
    },
    default: { seconds: 3 },
    boolean: ['verbose', 'follow']
});

// Set up help message
if (argv.help || argv.h) {
    console.log(chalk.cyan(`
watch-glob - Watch files matching a glob pattern and display changes in real-time

Usage:
  bun src/watch-glob/index.ts [glob-pattern] [options]

Options:
  --seconds, -s    Polling interval in seconds for directory rescans (default: 3)
  --verbose, -v    Enable verbose logging
  --follow, -f     Follow mode: tail files continuously
  --help, -h       Show this help message

Examples:
  bun src/watch-glob/index.ts "src/**/*.ts" --seconds 1
  bun src/watch-glob/index.ts "~/projects/**/*.{js,ts,tsx}" -v -f
`));
    process.exit(0);
}

// Get the glob pattern from arguments
let globPattern = argv._[0];
if (!globPattern) {
    console.error(chalk.red('Error: No glob pattern provided'));
    console.log(chalk.yellow('Use --help for usage information'));
    process.exit(1);
}

// Expand tilde to home directory if present
if (globPattern.startsWith('~/')) {
    globPattern = globPattern.replace(/^~\//, `${os.homedir()}/`);
}

// Normalize path separators for windows compatibility
globPattern = globPattern.replace(/\\/g, '/');

// Convert relative path to absolute if it's not already absolute
if (!path.isAbsolute(globPattern)) {
    globPattern = path.resolve(process.cwd(), globPattern);
}

const log = {
    info: (message: string) => console.log(chalk.blue('ℹ️ ') + message),
    debug: (message: string) => argv.verbose ? console.log(chalk.gray('🔍 ') + message) : null,
    error: (message: string, err?: any) => console.error(chalk.red('❌ ') + message + (err ? ': ' + err : '')),
    warn: (message: string) => console.log(chalk.yellow('⚠️ ') + message),
    file: {
        new: (filepath: string) => console.log(chalk.green(`\n📄 NEW FILE: ${filepath}`)),
        change: (filepath: string) => console.log(chalk.yellow(`\n📝 UPDATED: ${filepath}`)),
        remove: (filepath: string) => console.log(chalk.red(`\n🗑️  REMOVED: ${filepath}`)),
        content: (content: string) => {
            // Use a box with a distinct color for file content
            console.log(chalk.cyan('┌' + '─'.repeat(78) + '┐'));
            
            // Split by lines and add a prefix to each line
            const lines = content.split('\n');
            for (const line of lines) {
                console.log(chalk.cyan('│ ') + line);
            }
            
            console.log(chalk.cyan('└' + '─'.repeat(78) + '┘'));
        }
    },
    summary: {
        directories: (dirs: Set<string>) => {
            console.log(chalk.magenta('\n📁 WATCHED DIRECTORIES:'));
            Array.from(dirs).sort().forEach(dir => {
                console.log(chalk.magenta('   ├─ ') + dir);
            });
        },
        files: (files: Set<string>) => {
            console.log(chalk.green('\n📁 WATCHED FILES:'));
            Array.from(files).sort().forEach(file => {
                console.log(chalk.green('   ├─ ') + file);
            });
        }
    }
};

log.info(`Watching files matching pattern: ${chalk.cyan(globPattern)}`);
log.info(`Directory rescan interval: ${chalk.yellow(argv.seconds.toString())} seconds`);
if (argv.follow) {
    log.info('Follow mode enabled: continuously tailing files');
}
if (argv.verbose) {
    log.info('Verbose logging enabled');
}

// Initialize the file tracking data
const filePositions: Record<string, number> = {};
const scannedDirectories = new Set<string>();
const matchedFiles = new Set<string>();

// Helper function to read and display file content in tail -f style
function tailFile(filepath: string, follow = false) {
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
        
        // Get file descriptor
        const fd = fs.openSync(filepath, 'r');
        
        // Determine the starting position for reading
        const isNewFile = !(filepath in filePositions);
        const startPosition = isNewFile ? (follow ? stats.size : 0) : filePositions[filepath];
        const fileSize = stats.size;
        
        // Track the file and its directory
        matchedFiles.add(filepath);
        const dirPath = path.dirname(filepath);
        scannedDirectories.add(dirPath);
        
        log.debug(`File size: ${fileSize}, Start position: ${startPosition}, Is new: ${isNewFile}`);
        
        // If there's new content
        if (fileSize > startPosition) {
            // Allocate buffer for new content
            const bufferSize = fileSize - startPosition;
            const buffer = Buffer.alloc(bufferSize);
            
            // Read new content
            fs.readSync(fd, buffer, 0, bufferSize, startPosition);
            const newContent = buffer.toString('utf8');
            
            // Display file information and new content
            const timestamp = new Date().toLocaleTimeString();
            if (isNewFile) {
                log.file.new(`${timestamp} - ${filepath}`);
            } else {
                log.file.change(`${timestamp} - ${filepath}`);
            }
            
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

// Function to print scanned directories and files
function printScannedPaths() {
    log.summary.directories(scannedDirectories);
    log.summary.files(matchedFiles);
    console.log(); // Add empty line for better readability
}

// Function to scan for files matching the glob pattern
async function scanForFiles(): Promise<string[]> {
    log.debug(`Performing glob scan for: ${globPattern}`);
    
    try {
        const files = await glob(globPattern, { 
            absolute: true,
            dot: true, 
            nodir: true,
            windowsPathsNoEscape: true
        });
        
        if (files.length === 0) {
            log.debug('No files found matching the pattern');
        } else {
            log.debug(`Found ${files.length} files matching the pattern`);
        }
        
        return files;
    } catch (err) {
        log.error(`Error during file scan`, err);
        return [];
    }
}

// Process new files that aren't being tracked yet
function processNewFiles(files: string[]) {
    for (const file of files) {
        if (!matchedFiles.has(file)) {
            if (argv.follow) {
                // In follow mode, just track the files but don't display content
                try {
                    const stats = fs.statSync(file);
                    filePositions[file] = stats.size;
                    matchedFiles.add(file);
                    scannedDirectories.add(path.dirname(file));
                    
                    log.debug(`Tracking new file: ${file}`);
                } catch (err) {
                    log.error(`Error processing file ${file}`, err);
                }
            } else {
                // Display content in non-follow mode
                tailFile(file, false);
            }
        }
    }
}

// Function to directly check for file changes (using fs.watch API)
async function setupFileWatchers() {
    try {
        // For each tracked file, set up a watcher for direct file changes
        Array.from(matchedFiles).forEach(file => {
            try {
                fs.watch(file, { persistent: true }, (eventType) => {
                    if (eventType === 'change') {
                        log.debug(`Direct fs.watch event (change) for ${file}`);
                        // Immediately check the file size and read new content
                        try {
                            if (fs.existsSync(file)) {
                                const stats = fs.statSync(file);
                                const currentSize = stats.size;
                                const trackedSize = filePositions[file] || 0;
                                
                                if (currentSize > trackedSize) {
                                    tailFile(file);
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
    log.info(chalk.cyan('Performing initial scan for existing files...'));
    const initialFiles = await scanForFiles();
    processNewFiles(initialFiles);
    printScannedPaths();
    
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
            pollInterval: 50
        },
        disableGlobbing: true // We handle globbing ourselves
    };
    
    log.info(chalk.cyan('Starting file watcher...'));
    
    // Start watching with chokidar - watch individual files and their parent directories
    const watcher = chokidar.watch(Array.from(matchedFiles), watchOptions);
    
    // Also watch immediate parent directories of matched files to detect new files quickly
    const parentDirs = Array.from(scannedDirectories);
    if (parentDirs.length > 0) {
        watcher.add(parentDirs);
    }
    
    // Set up chokidar event handlers
    watcher
        .on('add', (filepath) => {
            log.debug(`File added event: ${filepath}`);
            if (!matchedFiles.has(filepath)) {
                // Check if this file matches our glob pattern
                try {
                    const files = glob.sync(globPattern, { 
                        absolute: true, 
                        dot: true, 
                        nodir: true,
                        windowsPathsNoEscape: true
                    });
                    
                    if (files.includes(filepath)) {
                        tailFile(filepath, false);
                        // Set up direct watcher for this new file
                        try {
                            fs.watch(filepath, { persistent: true }, (eventType) => {
                                if (eventType === 'change') {
                                    log.debug(`Direct fs.watch event (change) for ${filepath}`);
                                    tailFile(filepath);
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
        .on('change', (filepath) => {
            log.debug(`File changed event: ${filepath}`);
            if (matchedFiles.has(filepath)) {
                // Immediately tail the file when a change is detected
                tailFile(filepath);
            }
        })
        .on('unlink', (filepath) => {
            if (matchedFiles.has(filepath)) {
                log.debug(`File removed event: ${filepath}`);
                log.file.remove(`${new Date().toLocaleTimeString()} - ${filepath}`);
                
                // Remove from tracking
                delete filePositions[filepath];
                matchedFiles.delete(filepath);
                
                // Check if directory is now empty
                const dirPath = path.dirname(filepath);
                const dirHasFiles = Array.from(matchedFiles).some(file => path.dirname(file) === dirPath);
                if (!dirHasFiles) {
                    scannedDirectories.delete(dirPath);
                }
            }
        })
        .on('error', (error) => {
            log.error(`Watcher error`, error);
        })
        .on('ready', () => {
            log.info(chalk.green('Watcher initialized and ready'));
        });
    
    // Fallback check in case any file system events are missed
    const fileCheckInterval = setInterval(() => {
        Array.from(matchedFiles).forEach(file => {
            try {
                if (fs.existsSync(file)) {
                    const stats = fs.statSync(file);
                    const currentSize = stats.size;
                    const trackedSize = filePositions[file] || 0;
                    
                    if (currentSize > trackedSize) {
                        log.debug(`File size change detected in interval check: ${file} (${trackedSize} -> ${currentSize})`);
                        tailFile(file);
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
                const newFiles = currentFiles.filter(file => !matchedFiles.has(file));
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
                const newDirs = Array.from(scannedDirectories).filter(dir => !parentDirs.includes(dir));
                if (newDirs.length > 0) {
                    watcher.add(newDirs);
                    parentDirs.push(...newDirs);
                }
            }
            
            // Check for deleted files
            const deletedFiles = Array.from(matchedFiles).filter(file => !currentFiles.includes(file));
            if (deletedFiles.length > 0) {
                log.debug(`Detected ${deletedFiles.length} deleted file(s) during rescan`);
                
                deletedFiles.forEach(file => {
                    log.debug(`File detected as deleted during rescan: ${file}`);
                    
                    if (matchedFiles.has(file)) {
                        log.file.remove(`${new Date().toLocaleTimeString()} - ${file}`);
                        matchedFiles.delete(file);
                        delete filePositions[file];
                    }
                });
            }
        } catch (err) {
            log.error(`Error during rescan`, err);
        }
    }, argv.seconds * 1000);
    
    // Handle process termination
    process.on('SIGINT', () => {
        log.info(chalk.yellow('Stopping file watcher...'));
        clearInterval(fileCheckInterval);
        clearInterval(rescanInterval);
        watcher.close().then(() => process.exit(0));
    });
    
    log.info(chalk.green('Watch-glob is running. Press Ctrl+C to stop.'));
}

// Start the application
startWatcher();