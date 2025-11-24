import minimist from "minimist";
import { basename, dirname, extname, join, resolve, relative } from "node:path";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { minimatch } from "minimatch";
import logger from "@app/logger";
import type { FileSink } from "bun";
import { estimateTokens, formatTokens } from "@ask/utils/helpers";

// --- Interfaces ---
interface Options {
    paths?: string[];
    extension?: string[];
    includeHidden?: boolean;
    ignoreFilesOnly?: boolean;
    ignoreGitignore?: boolean;
    ignore?: string[];
    output?: string;
    cxml?: boolean;
    markdown?: boolean;
    lineNumbers?: boolean;
    flatFolder?: boolean;
    null?: boolean;
    help?: boolean;
    version?: boolean;
    dry?: boolean;
    // Aliases
    e?: string[];
    o?: string;
    c?: boolean;
    m?: boolean;
    n?: boolean;
    f?: boolean;
    h?: boolean;
    0?: boolean;
}

interface Args extends Options {
    _: string[]; // Positional arguments
}

interface IgnoredFile {
    path: string;
    reason: "gitignore" | "extension" | "pattern";
    isDirectory?: boolean;
}

interface Statistics {
    files: string[];
    directories: string[];
    totalSize: number;
    totalTokens: number;
    fileCount: number;
    directoryCount: number;
    skippedByGitignore: number;
    skippedByExtension: number;
    skippedByPattern: number;
    ignoredFiles: IgnoredFile[];
    basePath?: string;
}

// --- Constants ---
let globalIndex = 1; // Used for XML index numbering

// Default extensions to exclude (binary files, images, media, etc.)
const DEFAULT_EXCLUDED_EXTENSIONS = [
    // Images
    "png",
    "jpg",
    "jpeg",
    "gif",
    "svg",
    "webp",
    "ico",
    "bmp",
    "tiff",
    "tif",
    "heic",
    "heif",
    // Media
    "mp4",
    "avi",
    "mov",
    "wmv",
    "flv",
    "webm",
    "mkv",
    "mp3",
    "wav",
    "flac",
    "aac",
    "ogg",
    "m4a",
    // Archives
    "zip",
    "tar",
    "gz",
    "bz2",
    "xz",
    "7z",
    "rar",
    "z",
    "tgz",
    // Binaries
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "app",
    "deb",
    "rpm",
    "pkg",
    // Fonts
    "ttf",
    "otf",
    "woff",
    "woff2",
    "eot",
    // Other binary/data
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "db",
    "sqlite",
    "sqlite3",
    "lockb",
    "lock", // Lock files (but keep .lock for now as user might want them)
];

const EXT_TO_LANG: Record<string, string> = {
    py: "python",
    c: "c",
    cpp: "cpp",
    java: "java",
    js: "javascript",
    ts: "typescript",
    html: "html",
    css: "css",
    xml: "xml",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    sh: "bash",
    rb: "ruby",
};

// --- Helper Functions ---
function pathToFlatName(filePath: string, basePath: string): string {
    const relativePath = relative(basePath, filePath);
    return relativePath.replace(/[/\\]/g, "__");
}

function shouldIgnore(path: string, gitignoreRules: string[]): boolean {
    const baseFile = basename(path);
    // Separate negation rules (starting with !) from regular rules
    const regularRules = gitignoreRules.filter((rule) => !rule.startsWith("!"));
    const negationRules = gitignoreRules.filter((rule) => rule.startsWith("!")).map((rule) => rule.slice(1));

    // Check if file matches a negation rule first (un-ignore)
    if (negationRules.some((rule) => minimatch(baseFile, rule, { dot: true }))) {
        return false; // Explicitly un-ignored
    }

    // Check file match against regular rules
    const matchingRule = regularRules.find((rule) => minimatch(baseFile, rule, { dot: true }));
    if (matchingRule) {
        logger.debug(`shouldIgnore: ${path} matched rule: ${matchingRule}`);
        return true;
    }
    // Check directory match (ensure it ends with / for directory-specific rules)
    try {
        if (statSync(path).isDirectory()) {
            // Check negation rules for directories
            if (negationRules.some((rule) => minimatch(baseFile + "/", rule, { dot: true }))) {
                return false; // Explicitly un-ignored
            }
            // Check regular rules for directories
            if (regularRules.some((rule) => minimatch(baseFile + "/", rule, { dot: true }))) {
                return true;
            }
        }
    } catch (e) {
        // ignore stat errors if path disappears?
    }
    return false;
}

async function readGitignore(path: string): Promise<string[]> {
    const gitignorePath = join(path, ".gitignore");
    if (existsSync(gitignorePath)) {
        try {
            const content = await readFile(gitignorePath, { encoding: "utf-8" });
            return content
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith("#"));
        } catch (error) {
            logger.warn(`Could not read .gitignore at ${gitignorePath}: ${error}`);
            return [];
        }
    }
    return [];
}

function addLineNumbers(content: string): string {
    const lines = content.split("\n");
    const padding = String(lines.length).length;
    return lines.map((line, i) => `${String(i + 1).padStart(padding)}  ${line}`).join("\n");
}

type WriterFunc = (s: string) => void;

function printPath(
    writer: WriterFunc,
    path: string,
    content: string,
    cxml: boolean,
    markdown: boolean,
    lineNumbers: boolean
): void {
    if (cxml) {
        printAsXml(writer, path, content, lineNumbers);
    } else if (markdown) {
        printAsMarkdown(writer, path, content, lineNumbers);
    } else {
        printDefault(writer, path, content, lineNumbers);
    }
}

function printDefault(writer: WriterFunc, path: string, content: string, lineNumbers: boolean): void {
    writer(path);
    writer("---");
    if (lineNumbers) {
        content = addLineNumbers(content);
    }
    writer(content);
    writer("");
    writer("---");
}

function printAsXml(writer: WriterFunc, path: string, content: string, lineNumbers: boolean): void {
    writer(`<document index="${globalIndex}">`);
    writer(`<source>${path}</source>`);
    writer("<document_content>");
    if (lineNumbers) {
        content = addLineNumbers(content);
    }
    writer(content);
    writer("</document_content>");
    writer("</document>");
    globalIndex += 1;
}

function printAsMarkdown(writer: WriterFunc, path: string, content: string, lineNumbers: boolean): void {
    const ext = extname(path).slice(1); // Remove leading dot
    const lang = EXT_TO_LANG[ext] || "";
    let backticks = "```";
    while (content.includes(backticks)) {
        backticks += "`";
    }
    writer(path);
    writer(`${backticks}${lang}`);
    if (lineNumbers) {
        content = addLineNumbers(content);
    }
    writer(content);
    writer(`${backticks}`);
}

async function processPath(
    path: string,
    extensions: string[],
    includeHidden: boolean,
    ignoreFilesOnly: boolean,
    ignoreGitignore: boolean,
    gitignoreRules: string[], // Rules from parent/initial directory
    ignorePatterns: string[],
    writer: WriterFunc,
    claudeXml: boolean,
    markdown: boolean,
    lineNumbers: boolean,
    flatFolder: boolean = false,
    outputDir?: string,
    basePath?: string,
    dry: boolean = false,
    statistics?: Statistics
): Promise<void> {
    if (!existsSync(path)) {
        logger.error(`Path does not exist: ${path}`);
        return;
    }

    try {
        const stats = statSync(path);

        // Handle file case directly if initial path is a file
        if (stats.isFile()) {
            // Need to apply checks here too for the single-file case
            // Skip .env.* files by default (check before hidden files check)
            const fileName = basename(path);
            if (fileName.startsWith(".env")) {
                if (dry && statistics) {
                    statistics.skippedByPattern++;
                    statistics.ignoredFiles.push({ path, reason: "pattern" });
                }
                return;
            }
            // Apply gitignore rules if needed (check BEFORE hidden files check to track ignored hidden files)
            if (!ignoreGitignore && shouldIgnore(path, gitignoreRules)) {
                if (dry && statistics) {
                    statistics.skippedByGitignore++;
                    statistics.ignoredFiles.push({ path, reason: "gitignore" });
                }
                return;
            }
            if (!includeHidden && fileName.startsWith(".")) return;
            if (ignorePatterns.length > 0) {
                const baseName = basename(path);
                const matchesPattern = ignorePatterns.some((pattern) => minimatch(baseName, pattern, { dot: true }));
                if (matchesPattern) {
                    if (dry && statistics) {
                        statistics.skippedByPattern++;
                        statistics.ignoredFiles.push({ path, reason: "pattern" });
                    }
                    return; // ignoreFilesOnly doesn't apply here
                }
            }
            const ext = extname(path).slice(1).toLowerCase();
            // Skip default excluded extensions (images, binaries, etc.)
            if (DEFAULT_EXCLUDED_EXTENSIONS.includes(ext)) {
                if (dry && statistics) {
                    statistics.skippedByExtension++;
                    statistics.ignoredFiles.push({ path, reason: "extension" });
                }
                return;
            }
            // Skip if extension filter is specified and file doesn't match
            if (extensions.length > 0 && !extensions.includes(ext)) {
                if (dry && statistics) {
                    statistics.skippedByExtension++;
                    statistics.ignoredFiles.push({ path, reason: "extension" });
                }
                return;
            }

            if (dry && statistics) {
                statistics.files.push(path);
                statistics.fileCount++;
                try {
                    const fileStats = statSync(path);
                    statistics.totalSize += fileStats.size;
                    // Read file content to estimate tokens
                    const content = await readFile(path, { encoding: "utf-8" });
                    statistics.totalTokens += estimateTokens(content);
                } catch (e) {
                    // ignore errors
                }
                return;
            }

            if (flatFolder && outputDir && basePath) {
                // Copy file to flat structure
                const flatName = pathToFlatName(path, basePath);
                const destPath = join(outputDir, flatName);
                try {
                    await Bun.write(destPath, Bun.file(path));
                    logger.info(`Copied: ${path} -> ${destPath}`);
                } catch (error) {
                    logger.error(`Error copying file ${path}: ${error}`);
                }
            } else {
                // Original behavior - output content
                try {
                    const content = await readFile(path, { encoding: "utf-8" });
                    printPath(writer, path, content, claudeXml, markdown, lineNumbers);
                } catch (error) {
                    const message = `Warning: Skipping file ${path} due to error: ${error}`;
                    logger.error(message);
                }
            }
            return;
        }

        // Handle directory case
        if (stats.isDirectory()) {
            // Initial call to processDirectory starts with the initial gitignoreRules
            logger.debug(`Processing directory ${path}, writer type: ${typeof writer}`);
            if (dry && statistics) {
                statistics.directories.push(path);
                statistics.directoryCount++;
            }
            await processDirectory(path, gitignoreRules, dry, statistics);
        }
    } catch (error: any) {
        logger.error(`Error accessing path ${path}: ${error.message}`);
        return;
    }

    // Renamed original processPath's dir logic to processDirectory
    // Added passedRules parameter
    async function processDirectory(
        dirPath: string,
        passedRules: string[],
        dry: boolean = false,
        statistics?: Statistics
    ): Promise<void> {
        // Read .gitignore specifically for this directory
        let currentDirGitignoreRules = ignoreGitignore ? [] : await readGitignore(dirPath);
        // Combine passed rules with current dir's rules
        let effectiveGitignoreRules = [...passedRules, ...currentDirGitignoreRules];

        try {
            const entries = await readdir(dirPath, { withFileTypes: true });
            logger.debug(`Found ${entries.length} entries in ${dirPath}`);
            for (const entry of entries) {
                const entryPath = join(dirPath, entry.name);
                logger.debug(
                    `Processing entry: ${entry.name}, isFile: ${entry.isFile()}, isDirectory: ${entry.isDirectory()}`
                );

                // Skip .env.* files by default (check before hidden files check)
                if (entry.isFile() && entry.name.startsWith(".env")) {
                    if (dry && statistics) {
                        statistics.skippedByPattern++;
                        statistics.ignoredFiles.push({ path: entryPath, reason: "pattern" });
                    }
                    continue;
                }

                // Apply gitignore rules if needed (check BEFORE hidden files check to track ignored hidden files)
                if (!ignoreGitignore && shouldIgnore(entryPath, effectiveGitignoreRules)) {
                    logger.debug(`Skipping ${entryPath} - matched gitignore rule`);
                    if (dry && statistics) {
                        if (entry.isFile()) {
                            statistics.skippedByGitignore++;
                            statistics.ignoredFiles.push({ path: entryPath, reason: "gitignore" });
                        } else if (entry.isDirectory()) {
                            // Track ignored directories
                            statistics.ignoredFiles.push({ path: entryPath, reason: "gitignore", isDirectory: true });
                        }
                    }
                    continue;
                }

                // Skip hidden files/directories (respect includeHidden)
                if (!includeHidden && entry.name.startsWith(".")) {
                    continue;
                }

                // Apply ignore patterns if needed
                if (ignorePatterns.length > 0) {
                    const matchesPattern = ignorePatterns.some((pattern) =>
                        minimatch(entry.name, pattern, { dot: true })
                    );
                    if (matchesPattern && (entry.isFile() || !ignoreFilesOnly)) {
                        if (dry && statistics) {
                            if (entry.isFile()) {
                                statistics.skippedByPattern++;
                                statistics.ignoredFiles.push({ path: entryPath, reason: "pattern" });
                            } else if (entry.isDirectory()) {
                                statistics.ignoredFiles.push({ path: entryPath, reason: "pattern", isDirectory: true });
                            }
                        }
                        continue;
                    }
                }

                if (entry.isDirectory()) {
                    // Recursively process subdirectory, PASSING DOWN the effective rules
                    if (dry && statistics) {
                        statistics.directories.push(entryPath);
                        statistics.directoryCount++;
                    }
                    await processDirectory(entryPath, effectiveGitignoreRules, dry, statistics);
                } else if (entry.isFile()) {
                    const ext = extname(entry.name).slice(1).toLowerCase();
                    logger.debug(
                        `File ${entry.name} has extension: ${ext}, extensions filter: ${
                            extensions.length > 0 ? extensions.join(",") : "none"
                        }`
                    );
                    // Skip default excluded extensions (images, binaries, etc.)
                    if (DEFAULT_EXCLUDED_EXTENSIONS.includes(ext)) {
                        logger.debug(`Skipping ${entry.name} - excluded extension ${ext}`);
                        if (dry && statistics) {
                            statistics.skippedByExtension++;
                            statistics.ignoredFiles.push({ path: entryPath, reason: "extension" });
                        }
                        continue;
                    }
                    // Skip if extension filter is specified and file doesn't match
                    if (extensions.length > 0 && !extensions.includes(ext)) {
                        logger.debug(`Skipping ${entry.name} - extension ${ext} not in filter`);
                        if (dry && statistics) {
                            statistics.skippedByExtension++;
                            statistics.ignoredFiles.push({ path: entryPath, reason: "extension" });
                        }
                        continue;
                    }
                    logger.debug(`About to process file: ${entryPath}`);

                    if (dry && statistics) {
                        statistics.files.push(entryPath);
                        statistics.fileCount++;
                        try {
                            const fileStats = statSync(entryPath);
                            statistics.totalSize += fileStats.size;
                            // Read file content to estimate tokens
                            const content = await readFile(entryPath, { encoding: "utf-8" });
                            statistics.totalTokens += estimateTokens(content);
                        } catch (e) {
                            // ignore errors
                        }
                        continue;
                    }

                    if (flatFolder && outputDir && basePath) {
                        // Copy file to flat structure
                        const flatName = pathToFlatName(entryPath, basePath);
                        const destPath = join(outputDir, flatName);
                        try {
                            await Bun.write(destPath, Bun.file(entryPath));
                            logger.info(`Copied: ${entryPath} -> ${destPath}`);
                        } catch (error) {
                            logger.error(`Error copying file ${entryPath}: ${error}`);
                        }
                    } else {
                        // Original behavior - output content
                        try {
                            const content = await readFile(entryPath, { encoding: "utf-8" });
                            printPath(writer, entryPath, content, claudeXml, markdown, lineNumbers);
                        } catch (error) {
                            const message = `Warning: Skipping file ${entryPath} due to error: ${error}`;
                            logger.error(message);
                        }
                    }
                }
            }
        } catch (error: any) {
            logger.error(`Error reading directory ${dirPath}: ${error.message}`);
        }
    }
}

async function readPathsFromStdin(useNullSeparator: boolean): Promise<string[]> {
    const reader = Bun.stdin.stream().getReader();
    let input = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            input += Buffer.from(value).toString();
        }
    } finally {
        reader.releaseLock();
    }

    if (!input) {
        return [];
    }
    const separator = useNullSeparator ? "\0" : "\n";
    return input
        .split(separator)
        .map((s) => s.trim())
        .filter(Boolean);
}

function showVersion(): void {
    const VERSION = "1.0.0"; // Placeholder
    logger.info(`files-to-prompt v${VERSION}`);
}

function formatFileSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function toRelativePath(path: string, basePath?: string): string {
    if (!basePath) return path;
    try {
        return relative(basePath, path);
    } catch {
        return path;
    }
}

function groupIgnoredFilesByDirectory(ignoredFiles: IgnoredFile[], basePath?: string): Map<string, IgnoredFile[]> {
    const grouped = new Map<string, IgnoredFile[]>();

    for (const file of ignoredFiles) {
        // For directories, use the directory path itself
        // For files, use the parent directory
        const key = file.isDirectory
            ? toRelativePath(file.path, basePath)
            : toRelativePath(dirname(file.path), basePath);

        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key)!.push(file);
    }

    return grouped;
}

/**
 * Generic function to format a list of file paths using depth-based grouping.
 * Works with both string paths and IgnoredFile objects.
 */
function formatFileList<T extends string | IgnoredFile>(
    items: T[],
    basePath?: string,
    maxDisplayItems: number = 100,
    indent: string = "  "
): string[] {
    if (items.length === 0) return [];

    // Extract relative paths and metadata
    const pathsWithMeta = items.map((item) => {
        if (typeof item === "string") {
            return {
                relPath: item,
                isDirectory: item.endsWith("/"),
            };
        } else {
            return {
                relPath: toRelativePath(item.path, basePath),
                isDirectory: item.isDirectory || false,
            };
        }
    });

    // Group files by directory depth
    function groupFilesByDirectoryDepth(targetDepth: number): Map<string, typeof pathsWithMeta> {
        const groups = new Map<string, typeof pathsWithMeta>();

        for (const pathMeta of pathsWithMeta) {
            const parts = pathMeta.relPath.split(/[/\\]/).filter(Boolean);
            let groupKey: string;

            if (parts.length <= targetDepth) {
                // Show individual file/directory
                groupKey = pathMeta.relPath;
            } else {
                // Group by directory at target depth
                groupKey = parts.slice(0, targetDepth).join("/") + "/";
            }

            if (!groups.has(groupKey)) {
                groups.set(groupKey, []);
            }
            groups.get(groupKey)!.push(pathMeta);
        }

        return groups;
    }

    // Try progressively shallower depths until number of groups <= maxDisplayItems
    let currentDepth = 4;
    let selectedDepth = 1;
    let selectedGroups: Map<string, typeof pathsWithMeta> | null = null;

    while (currentDepth >= 1) {
        const groups = groupFilesByDirectoryDepth(currentDepth);
        if (groups.size <= maxDisplayItems) {
            selectedDepth = currentDepth;
            selectedGroups = groups;
            break;
        }
        currentDepth--;
    }

    // If no depth fits, use depth 1 and limit display
    if (!selectedGroups) {
        selectedGroups = groupFilesByDirectoryDepth(1);
    }

    // Sort groups: directories first, then by name
    const sortedGroups = Array.from(selectedGroups.entries()).sort((a, b) => {
        const aIsDir = a[0].endsWith("/") || a[1][0].isDirectory;
        const bIsDir = b[0].endsWith("/") || b[1][0].isDirectory;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a[0].localeCompare(b[0]);
    });

    // Build output items
    const outputItems: string[] = [];
    const groupsToShow = sortedGroups.slice(0, maxDisplayItems);
    for (const [key, files] of groupsToShow) {
        if (files.length === 1) {
            const path = files[0].relPath;
            const suffix = files[0].isDirectory ? "/" : "";
            outputItems.push(`${indent}- ${path}${suffix}`);
        } else {
            outputItems.push(`${indent}- ${key} (${files.length} files)`);
        }
    }

    // Add overflow message if needed
    if (selectedGroups.size > maxDisplayItems) {
        outputItems.push(
            `${indent}... and ${selectedGroups.size - maxDisplayItems} more ${
                selectedDepth === 1 ? "directories" : "items"
            }`
        );
    }

    return outputItems;
}

function printStatistics(stats: Statistics): void {
    // Use console.log to avoid timestamps in console output
    console.log("\n" + "=".repeat(60));
    console.log("DRY RUN STATISTICS");
    console.log("=".repeat(60));
    console.log(`\nFiles to process: ${stats.fileCount}`);
    console.log(`Directories found: ${stats.directoryCount}`);
    console.log(`Total size: ${formatFileSize(stats.totalSize)}`);
    console.log(`Estimated tokens: ${formatTokens(stats.totalTokens)}`);

    // Group ignored files by directory
    const ignoredByDir = groupIgnoredFilesByDirectory(stats.ignoredFiles, stats.basePath);

    if (stats.ignoredFiles.length > 0) {
        console.log(`\nIgnored files: ${stats.ignoredFiles.length}`);

        // Group by reason
        const byReason = {
            gitignore: stats.ignoredFiles.filter((f) => f.reason === "gitignore"),
            extension: stats.ignoredFiles.filter((f) => f.reason === "extension"),
            pattern: stats.ignoredFiles.filter((f) => f.reason === "pattern"),
        };

        if (byReason.gitignore.length > 0) {
            const dirs = byReason.gitignore.filter((f) => f.isDirectory);
            const files = byReason.gitignore.filter((f) => !f.isDirectory);
            const totalCount = dirs.length + files.length;
            console.log(
                `\n  By gitignore (${totalCount}${
                    dirs.length > 0 ? `: ${dirs.length} directories, ${files.length} files` : ""
                }):`
            );
            const items = formatFileList(byReason.gitignore, stats.basePath, 100, "    ");
            items.forEach((item) => console.log(item));
        }

        if (byReason.extension.length > 0) {
            console.log(`\n  By extension filter (${byReason.extension.length}):`);
            const items = formatFileList(byReason.extension, stats.basePath, 100, "    ");
            items.forEach((item) => console.log(item));
        }

        if (byReason.pattern.length > 0) {
            console.log(`\n  By ignore pattern (${byReason.pattern.length}):`);
            const items = formatFileList(byReason.pattern, stats.basePath, 100, "    ");
            items.forEach((item) => console.log(item));
        }
    }

    if (stats.files.length > 0) {
        console.log(`\nFiles that would be processed (${stats.files.length}):`);

        const allFiles = stats.files.map((f) => toRelativePath(f, stats.basePath)).sort();
        const items = formatFileList(allFiles, stats.basePath, 100, "  ");
        console.log(items.join("\n"));
    }

    console.log("\n" + "=".repeat(60) + "\n");
}

function showHelp(): void {
    showVersion(); // Add version info to help output
    logger.info(`
Files-to-Prompt: Convert files to a prompt format for AI systems

Usage: files-to-prompt [options] [paths...]

Arguments:
  paths                   One or more paths to files or directories

Options:
  -e, --extension EXT     File extensions to include (can use multiple times)
  --include-hidden        Include files and folders starting with .
  --ignore-files-only     --ignore option only ignores files
  --ignore-gitignore      Ignore .gitignore files and include all files
  --ignore PATTERN        List of patterns to ignore (can use multiple times)
  -o, --output FILE       Output to a file instead of stdout (or directory for --flat-folder)
  -c, --cxml              Output in XML-ish format suitable for Claude
  -m, --markdown          Output Markdown with fenced code blocks
  -n, --line-numbers      Add line numbers to the output
  -f, --flat-folder       Copy files to a flat folder structure with renamed files
  -0, --null              Use NUL character as separator when reading from stdin
  --dry                   Show statistics about what would be processed without actually processing
  -h, --help              Show this help message
  --version               Show version information

Examples:
  files-to-prompt src/components
  files-to-prompt -e js -e ts src/
  files-to-prompt --markdown -o output.md project/
  files-to-prompt --flat-folder -o flat-output/ src/
  find . -name "*.py" | files-to-prompt -0
`);
}

async function main(): Promise<void> {
    try {
        // Wrap main logic
        const argv = minimist<Args>(process.argv.slice(2), {
            alias: {
                e: "extension",
                o: "output",
                c: "cxml",
                m: "markdown",
                h: "help",
                v: "version",
                "0": "null",
                f: "flatFolder",
            },
            boolean: [
                "includeHidden",
                "ignoreFilesOnly",
                "ignoreGitignore",
                "cxml",
                "markdown",
                "lineNumbers", // IMPORTANT: Treat -n as boolean if no value given
                "null",
                "help",
                "version",
                "flatFolder",
                "dry",
            ],
            string: ["output"],
            // Declare potentially multi-value args explicitly if needed by minimist typing/parsing
            // minimist might need hints for array types if they aren't consistently used with multiple flags
            // For now, assuming basic parsing works for -e val1 -e val2
        });

        if (argv.help) {
            showHelp();
            process.exit(0);
        }
        if (argv.version) {
            showVersion();
            process.exit(0);
        }

        const paths = argv._;
        if (paths.length === 0 && process.stdin.isTTY) {
            logger.error("Error: No input paths provided.");
            showHelp();
            process.exit(1);
        }

        const extensions = (
            Array.isArray(argv.extension) ? argv.extension : typeof argv.extension === "string" ? [argv.extension] : []
        ).map((ext) => ext.toLowerCase().replace(/^\./, "")); // Normalize extensions
        const includeHidden = !!argv.includeHidden;
        const ignoreFilesOnly = !!argv.ignoreFilesOnly;
        const ignoreGitignore = !!argv.ignoreGitignore;
        const ignorePatterns = Array.isArray(argv.ignore)
            ? argv.ignore
            : typeof argv.ignore === "string"
            ? [argv.ignore]
            : [];
        const outputFile = argv.output;
        const claudeXml = !!argv.cxml;
        const markdown = !!argv.markdown;
        const lineNumbers = !!argv.lineNumbers; // Now correctly uses boolean flag value
        const readStdinNull = !!argv.null;
        const flatFolder = !!(argv.flatFolder || argv["flat-folder"]);
        const dry = !!argv.dry;

        // Validate options
        if (flatFolder && !outputFile) {
            logger.error("Error: --flat-folder requires -o/--output to specify the destination directory.");
            process.exit(1);
        }

        if (flatFolder && (claudeXml || markdown)) {
            logger.error("Error: --flat-folder cannot be used with --cxml or --markdown options.");
            process.exit(1);
        }

        // Initialize statistics for dry-run mode
        const statistics: Statistics = {
            files: [],
            directories: [],
            totalSize: 0,
            totalTokens: 0,
            fileCount: 0,
            directoryCount: 0,
            skippedByGitignore: 0,
            skippedByExtension: 0,
            skippedByPattern: 0,
            ignoredFiles: [],
            basePath: process.cwd(),
        };

        let writer: WriterFunc = (s: string) => {
            process.stdout.write(s + "\n");
        };
        let fileSink: FileSink | null = null;

        if (outputFile && !flatFolder) {
            try {
                const outputDir = dirname(outputFile);
                if (!existsSync(outputDir)) {
                    await mkdir(outputDir, { recursive: true });
                }
                fileSink = Bun.file(outputFile).writer();
                writer = (s: string) => {
                    (fileSink as FileSink).write(s + "\n");
                };
            } catch (error: any) {
                logger.error(`Error setting up output file ${outputFile}: ${error.message}`);
                process.exit(1);
            }
        } else if (flatFolder && outputFile) {
            // Create output directory for flat folder structure
            try {
                if (!existsSync(outputFile)) {
                    await mkdir(outputFile, { recursive: true });
                } else if (!statSync(outputFile).isDirectory()) {
                    logger.error(`Error: Output path ${outputFile} exists but is not a directory.`);
                    process.exit(1);
                }
            } catch (error: any) {
                logger.error(`Error setting up output directory ${outputFile}: ${error.message}`);
                process.exit(1);
            }
        }

        let processedPaths: string[] = [];
        if (paths.length > 0) {
            processedPaths = paths.map((p) => resolve(p)); // Resolve initial paths
        } else {
            processedPaths = await readPathsFromStdin(readStdinNull);
            processedPaths = processedPaths.map((p) => resolve(p));
        }

        // Calculate common base path for flat folder mode
        let commonBasePath: string | undefined;
        if (flatFolder && processedPaths.length > 0) {
            // Find the common base directory for all paths
            commonBasePath = processedPaths[0];
            try {
                const stats = statSync(commonBasePath);
                if (!stats.isDirectory()) {
                    commonBasePath = dirname(commonBasePath);
                }
            } catch (error) {
                commonBasePath = dirname(commonBasePath);
            }

            // Find the deepest common directory
            for (let i = 1; i < processedPaths.length; i++) {
                let currentPath = processedPaths[i];
                try {
                    const stats = statSync(currentPath);
                    if (!stats.isDirectory()) {
                        currentPath = dirname(currentPath);
                    }
                } catch (error) {
                    currentPath = dirname(currentPath);
                }

                // Find common path between commonBasePath and currentPath
                const commonParts: string[] = [];
                const baseParts = commonBasePath.split(/[/\\]/);
                const currentParts = currentPath.split(/[/\\]/);

                for (let j = 0; j < Math.min(baseParts.length, currentParts.length); j++) {
                    if (baseParts[j] === currentParts[j]) {
                        commonParts.push(baseParts[j]);
                    } else {
                        break;
                    }
                }

                commonBasePath = commonParts.join("/");
            }
        }

        // Update basePath for statistics (use common base path or first path's directory)
        if (dry && processedPaths.length > 0) {
            if (commonBasePath) {
                statistics.basePath = commonBasePath;
            } else {
                try {
                    const firstPathStats = statSync(processedPaths[0]);
                    statistics.basePath = firstPathStats.isDirectory() ? processedPaths[0] : dirname(processedPaths[0]);
                } catch {
                    statistics.basePath = dirname(processedPaths[0]);
                }
            }
        }

        // Process each path
        for (const path of processedPaths) {
            logger.debug(`Processing path: ${path}, cwd: ${process.cwd()}`);
            let initialGitignoreRules = ignoreGitignore ? [] : await readGitignore(dirname(path));
            logger.debug(`Initial gitignore rules: ${initialGitignoreRules.length} rules`);

            await processPath(
                path,
                extensions,
                includeHidden,
                ignoreFilesOnly,
                ignoreGitignore,
                initialGitignoreRules, // Pass initial rules
                ignorePatterns,
                writer,
                claudeXml,
                markdown,
                lineNumbers,
                flatFolder,
                flatFolder ? outputFile : undefined,
                commonBasePath,
                dry,
                dry ? statistics : undefined
            );
        }

        // Print statistics if dry-run mode
        if (dry) {
            printStatistics(statistics);
        }

        if (fileSink) {
            await fileSink.end();
        }
    } catch (error: any) {
        // Catch errors in main
        logger.error(`An unexpected error occurred: ${error.message}`);
        // Optionally log stack trace for debugging
        // console.error(error.stack);
        process.exit(1);
    }
}

main();
