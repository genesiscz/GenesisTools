// Review thread output formatting - terminal (chalk), markdown, JSON
// Extracted from src/github-pr/index.ts, adapted to use chalk

import type { ParsedReviewThread, ReviewData } from "@app/github/types";
import chalk from "chalk";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// =============================================================================
// Terminal Formatting (chalk)
// =============================================================================

function formatDiffHunk(diffHunk: string | null): string {
    if (!diffHunk) return "";

    const lines = diffHunk.split("\n");
    return lines
        .map((line) => {
            if (line.startsWith("+")) {
                return chalk.green(line);
            } else if (line.startsWith("-")) {
                return chalk.red(line);
            } else if (line.startsWith("@@")) {
                return chalk.cyan(line);
            }
            return chalk.dim(line);
        })
        .join("\n");
}

function formatSuggestion(suggestion: string | null, diffHunk: string | null): string {
    if (!suggestion) return "";

    const suggestionLines = suggestion.split("\n");

    let output = "\n" + chalk.bold.yellow("Suggested Change:") + "\n";
    output += chalk.dim("```diff") + "\n";

    // If we have a diff hunk, try to find the lines being replaced
    if (diffHunk) {
        const hunkLines = diffHunk.split("\n");
        const removedLines = hunkLines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
        for (const line of removedLines) {
            output += chalk.red(line) + "\n";
        }
    }

    // Show the suggestion as added lines
    for (const line of suggestionLines) {
        output += chalk.green("+" + line) + "\n";
    }

    output += chalk.dim("```") + "\n";
    return output;
}

function formatThread(thread: ParsedReviewThread): string {
    const severityColor =
        thread.severity === "high" ? chalk.red : thread.severity === "medium" ? chalk.yellow : chalk.green;
    const severityText = thread.severity.toUpperCase();
    const statusIcon = thread.status === "resolved" ? chalk.green("OK") : chalk.red("X");
    const statusText = thread.status === "resolved" ? "RESOLVED" : "UNRESOLVED";

    let output = "\n";
    output += chalk.cyan("=".repeat(90)) + "\n";
    output +=
        chalk.bold(`[THREAD #${thread.threadNumber}] `) +
        severityColor.bold(severityText) +
        ` - ${thread.title}\n`;
    output += chalk.cyan("=".repeat(90)) + "\n";

    output += `${chalk.bold("Status:")}   ${statusIcon} ${statusText}`;
    if (thread.replies.length > 0) {
        output += chalk.dim(` (${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"})`);
    }
    output += "\n";

    output += `${chalk.bold("File:")}     ${chalk.cyan(thread.file)}`;
    if (thread.line) {
        output += chalk.yellow(`:${thread.line}`);
    }
    output += "\n";

    output += `${chalk.bold("Author:")}   ${thread.author}\n`;
    output += `${chalk.bold("Thread ID:")} ${chalk.dim(thread.threadId)}\n`;
    output += `${chalk.bold("First Comment ID:")} ${chalk.dim(thread.firstCommentId)}\n`;

    output += `\n${chalk.bold.magenta("Issue:")}\n${thread.issue}\n`;

    // Show diff context if available
    if (thread.diffHunk) {
        output += `\n${chalk.bold.blue("Code Context:")}\n`;
        output += formatDiffHunk(thread.diffHunk) + "\n";
    }

    // Show suggestion if available
    if (thread.suggestedCode) {
        output += formatSuggestion(thread.suggestedCode, thread.diffHunk);
    }

    // Show replies if any
    if (thread.replies.length > 0) {
        output += `\n${chalk.bold.cyan("Replies:")}\n`;
        for (const reply of thread.replies) {
            output +=
                chalk.dim(`  > ${reply.author} (${chalk.dim(reply.id)}): `) +
                reply.body.split("\n")[0].substring(0, 60) +
                "\n";
        }
    }

    return output;
}

function formatSummary(data: ReviewData, shownCount: number): string {
    const { stats } = data;

    let output = "\n";
    output += chalk.cyan("+" + "=".repeat(88) + "+") + "\n";
    output +=
        chalk.cyan("|") +
        chalk.bold(`  PR #${data.prNumber}: `) +
        data.title.substring(0, 70).padEnd(78) +
        chalk.cyan("|") +
        "\n";
    output +=
        chalk.cyan("|") + `  Repository: ${data.owner}/${data.repo}`.padEnd(87) + chalk.cyan("|") + "\n";
    output += chalk.cyan("|") + `  Status: ${data.state}`.padEnd(87) + chalk.cyan("|") + "\n";
    output += chalk.cyan("+" + "=".repeat(88) + "+") + "\n";

    output += "\n";
    const showingText = shownCount !== stats.total ? ` (showing ${shownCount})` : "";
    output += chalk.bold("Summary: ") + `${stats.total} threads${showingText} (`;
    output += (stats.unresolved > 0 ? chalk.red : chalk.green)(`${stats.unresolved} unresolved`) + ", ";
    output += chalk.green(`${stats.resolved} resolved`) + ")\n";
    output += `   HIGH: ${stats.high}  |  MEDIUM: ${stats.medium}  |  LOW: ${stats.low}\n`;

    return output;
}

/**
 * Format review data for terminal output (colorized)
 */
export function formatReviewTerminal(data: ReviewData, groupByFile: boolean): string {
    const { threads } = data;
    let output = formatSummary(data, threads.length);

    if (threads.length === 0) {
        output += chalk.dim("\nNo review comments found.\n");
        return output;
    }

    if (groupByFile) {
        const byFile = new Map<string, ParsedReviewThread[]>();
        for (const thread of threads) {
            const existing = byFile.get(thread.file) ?? [];
            existing.push(thread);
            byFile.set(thread.file, existing);
        }

        for (const [file, fileThreads] of byFile) {
            output += "\n" + chalk.dim("-".repeat(90)) + "\n";
            output += chalk.bold.cyan(`FILE: ${file}`) + chalk.dim(` (${fileThreads.length} threads)`) + "\n";
            output += chalk.dim("-".repeat(90)) + "\n";

            for (const thread of fileThreads) {
                output += formatThread(thread);
            }
        }
    } else {
        for (const thread of threads) {
            output += formatThread(thread);
        }
    }

    return output;
}

// =============================================================================
// Markdown Formatting
// =============================================================================

function formatMarkdownThread(thread: ParsedReviewThread): string {
    const severityEmoji = thread.severity === "high" ? "[HIGH]" : thread.severity === "medium" ? "[MED]" : "[LOW]";
    const statusEmoji = thread.status === "resolved" ? "[OK]" : "[X]";

    let output = `### Thread #${thread.threadNumber}: ${thread.title}\n\n`;

    output += `| Property | Value |\n`;
    output += `|----------|-------|\n`;
    output += `| **Status** | ${statusEmoji} ${thread.status.toUpperCase()} |\n`;
    output += `| **Severity** | ${severityEmoji} ${thread.severity.toUpperCase()} |\n`;
    output += `| **File** | \`${thread.file}${thread.line ? `:${thread.line}` : ""}\` |\n`;
    output += `| **Author** | @${thread.author} |\n`;
    output += `| **Thread ID** | \`${thread.threadId}\` |\n`;
    output += `| **First Comment ID** | \`${thread.firstCommentId}\` |\n`;
    if (thread.replies.length > 0) {
        output += `| **Replies** | ${thread.replies.length} |\n`;
    }
    output += "\n";

    output += `**Issue:**\n\n${thread.issue}\n\n`;

    if (thread.diffHunk) {
        output += `<details>\n<summary>Code Context</summary>\n\n\`\`\`diff\n${thread.diffHunk}\n\`\`\`\n\n</details>\n\n`;
    }

    if (thread.suggestedCode) {
        output += `**Suggested Change:**\n\n\`\`\`suggestion\n${thread.suggestedCode}\`\`\`\n\n`;
    }

    if (thread.replies.length > 0) {
        output += `**Replies:**\n\n`;
        for (const reply of thread.replies) {
            const replyPreview = reply.body.split("\n")[0].substring(0, 100);
            output += `- **@${reply.author}** (\`${reply.id}\`): ${replyPreview}${reply.body.length > 100 ? "..." : ""}\n`;
        }
        output += "\n";
    }

    output += "---\n\n";
    return output;
}

/**
 * Format review data as markdown
 */
export function formatReviewMarkdown(data: ReviewData, groupByFile: boolean): string {
    const { threads, stats } = data;

    let output = `# PR Review: #${data.prNumber}\n\n`;
    output += `**${data.title}**\n\n`;
    output += `| | |\n`;
    output += `|---|---|\n`;
    output += `| **Repository** | [${data.owner}/${data.repo}](https://github.com/${data.owner}/${data.repo}/pull/${data.prNumber}) |\n`;
    output += `| **State** | ${data.state} |\n`;
    output += `| **Generated** | ${new Date().toISOString()} |\n\n`;

    output += `## Summary\n\n`;
    output += `| Metric | Count |\n`;
    output += `|--------|-------|\n`;
    output += `| Total Threads | ${stats.total}${threads.length !== stats.total ? ` (showing ${threads.length})` : ""} |\n`;
    output += `| [X] Unresolved | ${stats.unresolved} |\n`;
    output += `| [OK] Resolved | ${stats.resolved} |\n`;
    output += `| [HIGH] High Priority | ${stats.high} |\n`;
    output += `| [MED] Medium Priority | ${stats.medium} |\n`;
    output += `| [LOW] Low Priority | ${stats.low} |\n\n`;

    if (threads.length === 0) {
        output += `*No review comments found.*\n`;
        return output;
    }

    output += `## Review Threads\n\n`;

    if (groupByFile) {
        const byFile = new Map<string, ParsedReviewThread[]>();
        for (const thread of threads) {
            const existing = byFile.get(thread.file) ?? [];
            existing.push(thread);
            byFile.set(thread.file, existing);
        }

        for (const [file, fileThreads] of byFile) {
            output += `## \`${file}\`\n\n`;
            output += `*${fileThreads.length} thread(s)*\n\n`;
            for (const thread of fileThreads) {
                output += formatMarkdownThread(thread);
            }
        }
    } else {
        for (const thread of threads) {
            output += formatMarkdownThread(thread);
        }
    }

    return output;
}

// =============================================================================
// JSON Formatting
// =============================================================================

/**
 * Format review data as JSON
 */
export function formatReviewJSON(data: ReviewData): string {
    return JSON.stringify(
        {
            repository: `${data.owner}/${data.repo}`,
            prNumber: data.prNumber,
            title: data.title,
            state: data.state,
            stats: data.stats,
            threads: data.threads,
        },
        null,
        2
    );
}

// =============================================================================
// File Output
// =============================================================================

/**
 * Save review markdown to .claude/github/reviews/
 */
export function saveReviewMarkdown(content: string, prNumber: number): string {
    const now = new Date();
    const datetime = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `pr-${prNumber}-${datetime}.md`;
    const reviewsDir = join(process.cwd(), ".claude", "github", "reviews");
    const filePath = join(reviewsDir, filename);

    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(filePath, content, "utf-8");

    return filePath;
}
