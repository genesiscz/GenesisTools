import minimist from "minimist";
import { readdirSync, lstatSync } from "fs";
import { resolve, join } from "path";
import chalk from "chalk";

const log = {
    info: (msg: string) => console.log(msg),
    ok: (msg: string) => console.log(chalk.green("✔ ") + msg),
    warn: (msg: string) => console.log(chalk.yellow("⚠ ") + msg),
    err: (msg: string, e?: unknown) => console.error(chalk.red("✖ ") + msg + (e ? `: ${String(e)}` : "")),
    debug: (_msg: string) => {},
};

interface Options {
    help?: boolean;
    verbose?: boolean;
}

interface Args extends Options {
    _: string[];
}

interface FileChange {
    file: string;
    status: string;
    mtime: Date;
}

interface TimeGroup {
    label: string;
    files: FileChange[];
}

function showHelp() {
    log.info(`
Usage: tools last-changes [options]

Shows uncommitted git changes grouped by modification time to help you
understand what files were updated and when.

Options:
  -v, --verbose   Enable verbose logging
  -h, --help      Show this help message
`);
}

function formatRelativeTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMinutes < 1) return "just now";
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? "s" : ""} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;

    return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatAbsoluteTime(date: Date): string {
    return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function getStatusColor(status: string): (text: string) => string {
    const firstChar = status.charAt(0);
    if (firstChar === "M" || firstChar === " ") return chalk.yellow;
    if (firstChar === "A") return chalk.green;
    if (firstChar === "D") return chalk.red;
    if (firstChar === "R") return chalk.blue;
    if (firstChar === "C") return chalk.cyan;
    return chalk.gray;
}

function getStatusDescription(status: string): string {
    const staged = status.charAt(0);
    const unstaged = status.charAt(1);

    if (staged === "M" && unstaged === "M") return "modified (staged & unstaged)";
    if (staged === "M") return "modified (staged)";
    if (unstaged === "M") return "modified (unstaged)";
    if (staged === "A") return "added (staged)";
    if (unstaged === "A") return "added (unstaged)";
    if (staged === "D") return "deleted (staged)";
    if (unstaged === "D") return "deleted (unstaged)";
    if (staged === "R") return "renamed (staged)";
    if (staged === "C") return "copied (staged)";
    if (staged === " " && unstaged === "?") return "untracked";
    return status;
}

function groupFilesByTime(files: FileChange[]): TimeGroup[] {
    const now = new Date();
    const groups: TimeGroup[] = [];

    let currentGroup: TimeGroup | null = null;

    for (const file of files) {
        const diffMs = now.getTime() - file.mtime.getTime();
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let label: string;

        if (diffHours < 1) {
            label = "Last hour";
        } else if (diffHours < 3) {
            label = "Last 3 hours";
        } else if (diffHours < 6) {
            label = "Last 6 hours";
        } else if (diffHours < 12) {
            label = "Last 12 hours";
        } else if (diffDays < 1) {
            label = "Today";
        } else if (diffDays < 2) {
            label = "Yesterday";
        } else if (diffDays < 7) {
            label = `Last ${diffDays} days`;
        } else {
            label = "Older";
        }

        if (!currentGroup || currentGroup.label !== label) {
            if (currentGroup) {
                groups.push(currentGroup);
            }
            currentGroup = { label, files: [] };
        }

        currentGroup.files.push(file);
    }

    if (currentGroup) {
        groups.push(currentGroup);
    }

    return groups;
}

function getFilesInDirectory(dirPath: string, basePath: string): FileChange[] {
    const result: FileChange[] = [];

    try {
        const entries = readdirSync(dirPath);

        for (const entry of entries) {
            const fullPath = join(dirPath, entry);
            const relativePath = join(basePath, entry);

            try {
                const stats = lstatSync(fullPath);

                if (stats.isDirectory()) {
                    result.push(...getFilesInDirectory(fullPath, relativePath));
                } else {
                    result.push({
                        file: relativePath,
                        status: "??",
                        mtime: stats.mtime,
                    });
                }
            } catch (_error: any) {
                continue;
            }
        }
    } catch (_error: any) {
        return result;
    }

    return result;
}

async function getUncommittedFiles(verbose: boolean): Promise<FileChange[]> {
    const proc = Bun.spawn({
        cmd: ["git", "status", "--porcelain"],
        stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(`git status failed: ${stderr || stdout}`);
    }

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);

    const files: FileChange[] = [];

    for (const rawLine of lines) {
        if (rawLine.length < 4) continue;

        const status = rawLine.substring(0, 2);
        let fileName = rawLine.substring(3);

        if (fileName.startsWith(" ")) {
            fileName = fileName.trimStart();
        } else {
            fileName = fileName.trim();
        }

        if (!fileName) continue;

        let filePath: string;

        if (status.charAt(0) === "R" || status.charAt(1) === "R") {
            const match = fileName.match(/^(.+?)\s+->\s+(.+)$/);
            if (match) {
                filePath = match[2];
            } else {
                filePath = fileName;
            }
        } else {
            filePath = fileName;
        }

        try {
            const absolutePath = resolve(filePath);
            const stats = lstatSync(absolutePath);

            if (stats.isDirectory() && status === "??") {
                const dirFiles = getFilesInDirectory(absolutePath, filePath);
                files.push(...dirFiles);
            } else {
                files.push({
                    file: filePath,
                    status,
                    mtime: stats.mtime,
                });
            }
        } catch (error: any) {
            if (status.includes("D")) {
                files.push({
                    file: filePath,
                    status,
                    mtime: new Date(),
                });
            } else {
                if (verbose) {
                    log.debug(`Skipping file "${filePath}": ${error.message}`);
                }
            }
        }
    }

    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return files;
}

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            v: "verbose",
            h: "help",
        },
        boolean: ["verbose", "help"],
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    const verbose = argv.verbose ?? false;
    if (verbose) {
        log.debug = (msg: string) => console.log(chalk.gray("🔍 " + msg));
    }

    try {
        const files = await getUncommittedFiles(verbose);

        if (files.length === 0) {
            log.ok("No uncommitted changes found.");
            process.exit(0);
        }

        const groups = groupFilesByTime(files);

        log.info(chalk.bold(`\n📋 Uncommitted Changes (${files.length} file${files.length !== 1 ? "s" : ""}):\n`));

        for (const group of groups) {
            log.info(
                chalk.bold(
                    chalk.cyan(`\n${group.label} (${group.files.length} file${group.files.length !== 1 ? "s" : ""}):`)
                )
            );

            for (const { file, status, mtime } of group.files) {
                const statusColor = getStatusColor(status);
                const statusText = statusColor(status);
                const description = getStatusDescription(status);
                const relativeTime = formatRelativeTime(mtime);
                const absoluteTime = formatAbsoluteTime(mtime);

                log.info(`  ${statusText}  ${chalk.white(file)} ${chalk.gray(`(${description})`)}`);
                log.info(`      ${chalk.gray(relativeTime)} ${chalk.dim(`(${absoluteTime})`)}`);
            }
        }

        log.info("");
    } catch (error: any) {
        log.err(`Error: ${error.message}`);
        if (error.stack && verbose) {
            log.err(error.stack);
        }
        process.exit(1);
    }
}

main().catch((err) => {
    log.err(`Unexpected error: ${err}`);
    process.exit(1);
});
