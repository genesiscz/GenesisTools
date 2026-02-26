/**
 * Git Commits Command
 *
 * Query commits by date range with author filtering, workitem ID extraction,
 * and optional line change stats.
 *
 * Usage:
 *   tools git commits --from 2026-02-01 --to 2026-02-08 [--author <name>] [--with-author <name>] [--format json|table] [--stat]
 */

import { extractFromMessage, loadWorkitemPatternsAsync } from "@app/git/workitem-patterns";
import { Executor } from "@app/utils/cli";
import type { DetailedCommitInfo } from "@app/utils/git";
import { Storage } from "@app/utils/storage";
import chalk from "chalk";
import type { Command } from "commander";

interface CommitsOptions {
    from: string;
    to: string;
    author?: string[];
    withAuthor?: string[];
    format: "json" | "table";
    stat?: boolean;
}

interface CommitWithStats extends DetailedCommitInfo {
    filesChanged: number;
    insertions: number;
    deletions: number;
    workitemIds: number[];
}

function addOneDay(dateStr: string): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
}

function formatDateForDisplay(dateStr: string): string {
    const d = new Date(dateStr);
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const day = dayNames[d.getDay()];
    return `${day} ${dateStr}`;
}

async function getCommitsByDate(
    from: string,
    to: string,
    authors: string[],
    includeStat: boolean
): Promise<CommitWithStats[]> {
    const executor = new Executor({ prefix: "git", verbose: false });

    const toExclusive = addOneDay(to);

    const args = [
        "log",
        `--after=${from}`,
        `--before=${toExclusive}`,
        "--all",
        "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s",
    ];

    if (includeStat) {
        args.push("--numstat");
    }

    for (const author of authors) {
        args.push(`--author=${author}`);
    }

    const result = await executor.exec(args);

    if (!result.success || !result.stdout.trim()) {
        return [];
    }

    const commits: CommitWithStats[] = [];
    const lines = result.stdout.split("\n");

    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();

        if (!line) {
            i++;
            continue;
        }

        // Check if this is a commit line (contains null bytes)
        if (!line.includes("\0")) {
            i++;
            continue;
        }

        const parts = line.split("\0");

        if (parts.length < 5) {
            i++;
            continue;
        }

        const [hash, shortHash, author, date, ...rest] = parts;
        const message = rest.join("\0");

        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;

        if (includeStat) {
            // Parse numstat lines that follow the commit
            i++;
            while (i < lines.length) {
                const statLine = lines[i].trim();

                if (!statLine || statLine.includes("\0")) {
                    break;
                }

                const statParts = statLine.split("\t");

                if (statParts.length >= 3) {
                    const ins = parseInt(statParts[0], 10);
                    const del = parseInt(statParts[1], 10);

                    if (!Number.isNaN(ins)) {
                        insertions += ins;
                    }

                    if (!Number.isNaN(del)) {
                        deletions += del;
                    }

                    filesChanged++;
                }

                i++;
            }
        } else {
            i++;
        }

        commits.push({
            hash,
            shortHash,
            author,
            date,
            message,
            filesChanged,
            insertions,
            deletions,
            workitemIds: [],
        });
    }

    return commits;
}

function groupByDay(commits: CommitWithStats[]): Map<string, CommitWithStats[]> {
    const groups = new Map<string, CommitWithStats[]>();

    for (const commit of commits) {
        const day = commit.date.split("T")[0];
        const existing = groups.get(day) ?? [];
        existing.push(commit);
        groups.set(day, existing);
    }

    return groups;
}

function outputTable(
    commits: CommitWithStats[],
    _from: string,
    _to: string,
    authors: string[],
    includeStat: boolean,
    workitemMap: Map<number, { commits: number; totalInsertions: number; totalDeletions: number }>
): void {
    const grouped = groupByDay(commits);
    const sortedDays = [...grouped.keys()].sort();

    for (const day of sortedDays) {
        const dayCommits = grouped.get(day)!;
        console.log(`\n${chalk.bold.cyan(formatDateForDisplay(day))} ${chalk.dim(`(${dayCommits.length} commits)`)}`);
        console.log(chalk.dim("─".repeat(80)));

        for (const commit of dayCommits) {
            const workitemTag =
                commit.workitemIds.length > 0
                    ? chalk.yellow(` [${commit.workitemIds.map((id) => `#${id}`).join(", ")}]`)
                    : "";

            const statTag =
                includeStat && (commit.insertions > 0 || commit.deletions > 0)
                    ? chalk.dim(` (${commit.filesChanged} files, +${commit.insertions}/-${commit.deletions})`)
                    : "";

            const authorTag = authors.length !== 1 ? chalk.dim(` (${commit.author})`) : "";

            console.log(`  ${chalk.dim(commit.shortHash)} ${commit.message}${workitemTag}${statTag}${authorTag}`);
        }
    }

    // Workitem summary
    if (workitemMap.size > 0) {
        console.log(`\n${chalk.bold("Workitem Summary:")}`);
        for (const [id, stats] of workitemMap) {
            const statPart = includeStat ? chalk.dim(` (+${stats.totalInsertions}/-${stats.totalDeletions})`) : "";
            console.log(`  ${chalk.yellow(`#${id}`)} - ${stats.commits} commit(s)${statPart}`);
        }
    }

    console.log(`\n${chalk.dim(`Total: ${commits.length} commits`)}`);
}

function outputJson(
    commits: CommitWithStats[],
    from: string,
    to: string,
    authors: string[],
    workitemMap: Map<number, { commits: number; totalInsertions: number; totalDeletions: number }>
): void {
    const workitemSummary: Record<string, { commits: number; totalInsertions: number; totalDeletions: number }> = {};

    for (const [id, stats] of workitemMap) {
        workitemSummary[String(id)] = stats;
    }

    const output = {
        from,
        to,
        authors,
        commits: commits.map((c) => ({
            hash: c.shortHash,
            date: c.date,
            message: c.message,
            author: c.author,
            filesChanged: c.filesChanged,
            insertions: c.insertions,
            deletions: c.deletions,
            workitemIds: c.workitemIds,
        })),
        workitemSummary,
    };

    console.log(JSON.stringify(output, null, 2));
}

async function handleCommits(options: CommitsOptions): Promise<void> {
    const storage = new Storage("git");
    const configAuthors = (await storage.getConfigValue<string[]>("authors")) ?? [];
    const patterns = await loadWorkitemPatternsAsync();

    let authors: string[] = [];

    if (options.author && options.author.length > 0) {
        authors = options.author;
    } else if (options.withAuthor && options.withAuthor.length > 0) {
        authors = [...configAuthors, ...options.withAuthor];
    } else {
        authors = configAuthors;
    }

    if (authors.length === 0) {
        console.log(chalk.dim("Note: No authors configured. Showing all commits."));
        console.log(chalk.dim('To pre-configure: tools git configure-authors --add "Your Name"'));
        console.log();
    }

    if (options.format !== "json") {
        const authorDisplay = authors.length > 0 ? authors.join(", ") : "all authors";
        console.log(chalk.bold(`Finding git commits from ${options.from} until ${options.to} from ${authorDisplay}`));
    }

    const commits = await getCommitsByDate(options.from, options.to, authors, !!options.stat);

    // Extract workitem IDs
    for (const commit of commits) {
        const refs = extractFromMessage(commit.message, patterns);
        commit.workitemIds = [...new Set(refs.map((r) => r.id))];
    }

    // Build workitem summary
    const workitemMap = new Map<number, { commits: number; totalInsertions: number; totalDeletions: number }>();

    for (const commit of commits) {
        for (const wid of commit.workitemIds) {
            const existing = workitemMap.get(wid) ?? { commits: 0, totalInsertions: 0, totalDeletions: 0 };
            existing.commits++;
            existing.totalInsertions += commit.insertions;
            existing.totalDeletions += commit.deletions;
            workitemMap.set(wid, existing);
        }
    }

    if (commits.length === 0) {
        console.log(chalk.yellow("\nNo commits found for the specified criteria."));
        return;
    }

    if (options.format === "json") {
        outputJson(commits, options.from, options.to, authors, workitemMap);
    } else {
        outputTable(commits, options.from, options.to, authors, !!options.stat, workitemMap);
    }
}

export function registerCommitsCommand(parent: Command, _storage: Storage): void {
    parent
        .command("commits")
        .description("Query commits by date range with author filtering and workitem extraction")
        .requiredOption("--from <date>", "Start date (YYYY-MM-DD)")
        .requiredOption("--to <date>", "End date (YYYY-MM-DD)")
        .option("--author <name...>", "Override: search only this author (repeatable)")
        .option("--with-author <name...>", "Append to configured authors (repeatable)")
        .option("--format <format>", "Output format: json or table", "table")
        .option("--stat", "Include line change stats (files changed, insertions, deletions)")
        .action(async (options: CommitsOptions) => {
            await handleCommits(options);
        });
}
