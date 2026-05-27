/**
 * Git Commits Command
 *
 * Query commits by date range with author filtering, workitem ID extraction,
 * branch attribution, rebase classification, and optional line change stats.
 */

import { enrichWorkItems } from "@app/azure-devops/lib/work-item-enrichment";
import { loadConfig } from "@app/azure-devops/config";
import {
    formatBranchTag,
    resolveBranchForCommits,
    type BranchAttribution,
} from "@app/git/lib/branch-attribution";
import { showItems } from "@app/git/lib/format";
import { renderMarkdown } from "@app/git/lib/markdown-render";
import { computePatchIds, dedupByPatchId } from "@app/git/lib/patch-id-dedup";
import {
    classifyCommit,
    clusterRebasedByCI,
    formatClusterTimestamp,
    formatYmd,
    isLikelyResetAuthor,
    rangeBoundsMs,
    type RebaseCluster,
} from "@app/git/lib/rebase-classifier";
import { extractFromMessage, loadWorkitemPatternsAsync } from "@app/git/workitem-patterns";
import { out } from "@app/logger";
import { Executor } from "@app/utils/cli";
import { copyToClipboard } from "@app/utils/clipboard";
import { formatDateTime } from "@app/utils/date";
import type { DetailedCommitInfo } from "@app/utils/git";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";
import chalk from "chalk";
import type { Command } from "commander";

type GroupBy = "day" | "branch" | "workitem" | "none";
type DateMode = "author" | "commit" | "true-first";

interface CommitsOptions {
    from: string;
    to: string;
    author?: string[];
    withAuthor?: string[];
    format: "json" | "table";
    stat?: boolean;
    groupBy?: GroupBy;
    withoutBranch?: boolean;
    withoutWorkitemId?: boolean;
    withWorkitemTitle?: boolean;
    withoutStashes?: boolean;
    withoutMerges?: boolean;
    workitem?: number[];
    includeRebases?: boolean;
    date?: DateMode;
    markdown?: boolean;
    clipboard?: boolean;
}

interface CommitWithStats extends DetailedCommitInfo {
    commitDate: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
    workitemIds: number[];
    parentCount: number;
    branchAttribution?: BranchAttribution;
    workitemTitles?: Map<number, string>;
    resetAuthorMarker?: boolean;
}

const DEFAULT_EXCLUDE_TRUNKS = ["develop", "main", "master"];

function addOneDay(dateStr: string): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
}

function formatDateForDisplay(dateStr: string): string {
    return formatDateTime(dateStr, { absolute: "date-long" });
}

function isStashSubject(message: string): boolean {
    return message.startsWith("WIP on ") || message.startsWith("index on ");
}

async function loadStashHashes(cwd: string): Promise<Set<string>> {
    const executor = new Executor({ prefix: "git", verbose: false, cwd });
    const res = await executor.exec(["stash", "list", "--format=%H"]);

    if (!res.success || !res.stdout.trim()) {
        return new Set();
    }

    return new Set(res.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
}

async function loadExcludeTrunks(storage: Storage): Promise<string[]> {
    const configured = await storage.getConfigValue<{ excludeTrunks?: string[] }>("branchAttribution");

    if (configured?.excludeTrunks && configured.excludeTrunks.length > 0) {
        return configured.excludeTrunks;
    }

    return DEFAULT_EXCLUDE_TRUNKS;
}

async function getCommitsByDate(
    from: string,
    to: string,
    authors: string[],
    includeStat: boolean,
    withoutMerges: boolean
): Promise<CommitWithStats[]> {
    const executor = new Executor({ prefix: "git", verbose: false });
    const toExclusive = addOneDay(to);

    const args = [
        "log",
        `--after=${from}`,
        `--before=${toExclusive}`,
        "--all",
        "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%cI%x00%s%x00%P",
    ];

    if (withoutMerges) {
        args.push("--no-merges");
    }

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

        if (!line.includes("\0")) {
            i++;
            continue;
        }

        const parts = line.split("\0");

        if (parts.length < 7) {
            i++;
            continue;
        }

        const [hash, shortHash, author, date, commitDate, message, parentPart] = parts;
        const parentCount = parentPart.trim() ? parentPart.trim().split(/\s+/).length : 0;

        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;

        if (includeStat) {
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
            commitDate,
            message,
            filesChanged,
            insertions,
            deletions,
            workitemIds: [],
            parentCount,
        });
    }

    return commits;
}

function groupingDateFor(commit: CommitWithStats, dateMode: DateMode, resetMarked: boolean): string {
    if (dateMode === "commit") {
        return commit.commitDate;
    }

    if (dateMode === "true-first" && resetMarked) {
        return commit.commitDate;
    }

    return commit.date;
}

function workitemTag(
    commit: CommitWithStats,
    showWorkitemId: boolean
): string {
    if (!showWorkitemId || commit.workitemIds.length === 0) {
        return "";
    }

    const parts = commit.workitemIds.map((id) => {
        const title = commit.workitemTitles?.get(id);

        if (title) {
            return chalk.yellow(` [#${id} — ${title}]`);
        }

        return chalk.yellow(` [#${id}]`);
    });

    return parts.join("");
}

function formatCommitRow(
    commit: CommitWithStats,
    opts: {
        showBranch: boolean;
        showWorkitemId: boolean;
        includeStat: boolean;
        showAuthor: boolean;
        authoredAnnotation?: string;
    }
): string {
    const marker = commit.resetAuthorMarker ? chalk.dim(" (?)") : "";
    const branch =
        opts.showBranch && commit.branchAttribution
            ? chalk.dim(` ${formatBranchTag(commit.branchAttribution)}`)
            : "";
    const stat =
        opts.includeStat && (commit.insertions > 0 || commit.deletions > 0)
            ? chalk.dim(` (${commit.filesChanged} files, +${commit.insertions}/-${commit.deletions})`)
            : "";
    const author = opts.showAuthor ? chalk.dim(` (${commit.author})`) : "";
    const authored = opts.authoredAnnotation ? chalk.dim(` ${opts.authoredAnnotation}`) : "";

    return `  ${chalk.dim(commit.shortHash)}${marker} ${commit.message}${branch}${workitemTag(commit, opts.showWorkitemId)}${stat}${authored}${author}`;
}

function buildWorkitemSummary(
    commits: CommitWithStats[],
    includeStat: boolean
): Map<number, { commits: number; totalInsertions: number; totalDeletions: number }> {
    const workitemMap = new Map<
        number,
        { commits: number; totalInsertions: number; totalDeletions: number }
    >();

    for (const commit of commits) {
        for (const wid of commit.workitemIds) {
            const existing = workitemMap.get(wid) ?? { commits: 0, totalInsertions: 0, totalDeletions: 0 };
            existing.commits++;
            existing.totalInsertions += commit.insertions;
            existing.totalDeletions += commit.deletions;
            workitemMap.set(wid, existing);
        }
    }

    return workitemMap;
}

function matchesWorkitemFilter(commit: CommitWithStats, filter: number[] | undefined): boolean {
    if (!filter || filter.length === 0) {
        return true;
    }

    return commit.workitemIds.some((id) => filter.includes(id));
}

function renderTableMain(
    commits: CommitWithStats[],
    opts: {
        groupBy: GroupBy;
        dateMode: DateMode;
        showBranch: boolean;
        showWorkitemId: boolean;
        includeStat: boolean;
        showAuthor: boolean;
        resetAuthorByHash: Map<string, boolean>;
    }
): void {
    const dateFn = (c: CommitWithStats) =>
        groupingDateFor(c, opts.dateMode, opts.resetAuthorByHash.get(c.hash) ?? false);

    if (opts.groupBy === "none") {
        const sorted = [...commits].sort((a, b) => dateFn(b).localeCompare(dateFn(a)));

        for (const commit of sorted) {
            out.println(formatCommitRow(commit, opts));
        }

        return;
    }

    if (opts.groupBy === "branch") {
        const groups = new Map<string, CommitWithStats[]>();

        for (const commit of commits) {
            const key = commit.branchAttribution?.branch ?? "(detached)";
            const list = groups.get(key) ?? [];
            list.push(commit);
            groups.set(key, list);
        }

        for (const [branch, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            out.println(`\n${chalk.bold.cyan(`[${branch}]`)} ${chalk.dim(`(${group.length} commits)`)}`);
            out.println(chalk.dim("─".repeat(80)));

            for (const commit of group) {
                const dateSuffix =
                    opts.dateMode !== "author"
                        ? chalk.dim(` (${commit.date.split("T")[0]})`)
                        : "";
                out.println(`${formatCommitRow(commit, opts)}${dateSuffix}`);
            }
        }

        return;
    }

    if (opts.groupBy === "workitem") {
        const groups = new Map<string, CommitWithStats[]>();

        for (const commit of commits) {
            const key = commit.workitemIds.length > 0 ? `#${commit.workitemIds[0]}` : "[no-workitem]";
            const list = groups.get(key) ?? [];
            list.push(commit);
            groups.set(key, list);
        }

        for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            out.println(`\n${chalk.bold.cyan(`[${key}]`)} ${chalk.dim(`(${group.length} commits)`)}`);
            out.println(chalk.dim("─".repeat(80)));

            for (const commit of group) {
                out.println(formatCommitRow(commit, opts));
            }
        }

        return;
    }

    const groups = new Map<string, CommitWithStats[]>();

    for (const commit of commits) {
        const day = dateFn(commit).split("T")[0];
        const list = groups.get(day) ?? [];
        list.push(commit);
        groups.set(day, list);
    }

    for (const day of [...groups.keys()].sort()) {
        const dayCommits = groups.get(day)!;
        out.println(`\n${chalk.bold.cyan(formatDateForDisplay(day))} ${chalk.dim(`(${dayCommits.length} commits)`)}`);
        out.println(chalk.dim("─".repeat(80)));

        for (const commit of dayCommits) {
            out.println(formatCommitRow(commit, opts));
        }
    }
}

function renderRebasedCompressed(clusters: RebaseCluster<CommitWithStats>[]): void {
    const total = clusters.reduce((sum, c) => sum + c.commits.length, 0);
    out.println(`\n${chalk.dim(`… and ${total} commits rebased into this range (use --include-rebases):`)}`);

    for (const cluster of clusters) {
        const landed = formatClusterTimestamp(cluster.landedAt);
        const from = formatYmd(cluster.authorDateRange[0]);
        const to = formatYmd(cluster.authorDateRange[1]);
        out.println(
            `  ${chalk.cyan("▸")} ${cluster.commits.length} commits rebased ${landed}, authored ${from} – ${to}`
        );
        out.println(
            `    [${showItems(cluster.commits, (c) => c.shortHash)}]`
        );
    }
}

function renderRebasedExpanded(
    rebased: CommitWithStats[],
    opts: {
        showBranch: boolean;
        showWorkitemId: boolean;
        includeStat: boolean;
        showAuthor: boolean;
    }
): void {
    out.println(`\n${chalk.bold("── Rebased into range (" + rebased.length + " commits) ──")}`);

    const groups = new Map<string, CommitWithStats[]>();

    for (const commit of rebased) {
        const day = commit.commitDate.split("T")[0];
        const list = groups.get(day) ?? [];
        list.push(commit);
        groups.set(day, list);
    }

    for (const day of [...groups.keys()].sort()) {
        const dayCommits = groups.get(day)!;
        out.println(`\n${chalk.bold.cyan(formatDateForDisplay(day))} ${chalk.dim(`(${dayCommits.length} commits)`)}`);
        out.println(chalk.dim("─".repeat(80)));

        for (const commit of dayCommits) {
            const authoredDay = commit.date.split("T")[0];
            const landedDay = commit.commitDate.split("T")[0];
            const authoredAnnotation =
                authoredDay !== landedDay ? `[authored ${authoredDay}]` : undefined;

            out.println(
                formatCommitRow(commit, {
                    ...opts,
                    authoredAnnotation,
                })
            );
        }
    }
}

function outputJson(payload: {
    from: string;
    to: string;
    authors: string[];
    commits: CommitWithStats[];
    rebasedCommits: CommitWithStats[];
    workitemSummary: Map<number, { commits: number; totalInsertions: number; totalDeletions: number }>;
}): void {
    const workitemSummary: Record<string, { commits: number; totalInsertions: number; totalDeletions: number }> = {};

    for (const [id, stats] of payload.workitemSummary) {
        workitemSummary[String(id)] = stats;
    }

    const mapCommit = (c: CommitWithStats) => ({
        hash: c.shortHash,
        fullHash: c.hash,
        date: c.date,
        commitDate: c.commitDate,
        message: c.message,
        author: c.author,
        branch: c.branchAttribution?.branch ?? null,
        trunkFallback: c.branchAttribution?.trunkFallback ?? false,
        filesChanged: c.filesChanged,
        insertions: c.insertions,
        deletions: c.deletions,
        workitemIds: c.workitemIds,
        resetAuthorMarker: c.resetAuthorMarker ?? false,
    });

    out.println(
        SafeJSON.stringify(
            {
                from: payload.from,
                to: payload.to,
                authors: payload.authors,
                commits: payload.commits.map(mapCommit),
                rebasedCommits: payload.rebasedCommits.map(mapCommit),
                workitemSummary,
            },
            null,
            2
        )
    );
}

async function handleCommits(options: CommitsOptions): Promise<void> {
    const storage = new Storage("git");
    const configAuthors = (await storage.getConfigValue<string[]>("authors")) ?? [];
    const patterns = await loadWorkitemPatternsAsync();
    const excludeTrunks = await loadExcludeTrunks(storage);
    const groupBy = options.groupBy ?? "day";
    const dateMode = options.date ?? "author";
    const showBranch = !options.withoutBranch;
    const showWorkitemId = !options.withoutWorkitemId;

    let authors: string[] = [];

    if (options.author && options.author.length > 0) {
        authors = options.author;
    } else if (options.withAuthor && options.withAuthor.length > 0) {
        authors = [...configAuthors, ...options.withAuthor];
    } else {
        authors = configAuthors;
    }

    if (authors.length === 0 && options.format !== "json" && !options.markdown) {
        out.println(chalk.dim("Note: No authors configured. Showing all commits."));
        out.println(chalk.dim('To pre-configure: tools git configure-authors --add "Your Name"'));
        out.println();
    }

    if (options.format !== "json" && !options.markdown) {
        const authorDisplay = authors.length > 0 ? authors.join(", ") : "all authors";
        out.println(chalk.bold(`Finding git commits from ${options.from} until ${options.to} from ${authorDisplay}`));
    }

    let commits = await getCommitsByDate(
        options.from,
        options.to,
        authors,
        !!options.stat,
        !!options.withoutMerges
    );

    if (options.withoutStashes) {
        const stashHashes = await loadStashHashes(process.cwd());

        commits = commits.filter(
            (c) => !isStashSubject(c.message) && !stashHashes.has(c.hash) && !stashHashes.has(c.shortHash)
        );
    }

    for (const commit of commits) {
        const refs = extractFromMessage(commit.message, patterns);
        commit.workitemIds = [...new Set(refs.map((r) => r.id))];
    }

    const patchIds = await computePatchIds(
        commits.map((c) => c.hash),
        process.cwd()
    );
    commits = dedupByPatchId(commits, patchIds);

    const bounds = rangeBoundsMs(options.from, options.to);
    const allForReset = commits;
    const authoredInRange: CommitWithStats[] = [];
    const rebasedInRange: CommitWithStats[] = [];

    for (const commit of commits) {
        const kind = classifyCommit(commit, bounds);

        if (kind === "authored") {
            authoredInRange.push(commit);
        } else if (kind === "rebased") {
            rebasedInRange.push(commit);
        }
    }

    const resetAuthorByHash = new Map<string, boolean>();

    for (const commit of allForReset) {
        resetAuthorByHash.set(commit.hash, isLikelyResetAuthor(commit, allForReset));
    }

    for (const commit of [...authoredInRange, ...rebasedInRange]) {
        commit.resetAuthorMarker = resetAuthorByHash.get(commit.hash) ?? false;
    }

    const workitemBySha = new Map<string, number[]>();

    for (const commit of [...authoredInRange, ...rebasedInRange]) {
        workitemBySha.set(commit.hash, commit.workitemIds);
    }

    const branchMap = await resolveBranchForCommits(
        [...workitemBySha.keys()],
        { excludeTrunks, workitemBySha, cwd: process.cwd() }
    );

    for (const commit of [...authoredInRange, ...rebasedInRange]) {
        commit.branchAttribution = branchMap.get(commit.hash);
    }

    if (options.withWorkitemTitle) {
        const azureConfig = loadConfig();

        if (azureConfig) {
            const allIds = [
                ...new Set(
                    [...authoredInRange, ...rebasedInRange].flatMap((c) => c.workitemIds)
                ),
            ];
            const enriched = await enrichWorkItems(azureConfig, allIds);

            for (const commit of [...authoredInRange, ...rebasedInRange]) {
                const titles = new Map<number, string>();

                for (const id of commit.workitemIds) {
                    const item = enriched.get(id);

                    if (item?.title) {
                        titles.set(id, item.title);
                    }
                }

                if (titles.size > 0) {
                    commit.workitemTitles = titles;
                }
            }
        }
    }

    let authored = authoredInRange;
    let rebased = rebasedInRange;

    if (options.workitem && options.workitem.length > 0) {
        authored = authored.filter((c) => matchesWorkitemFilter(c, options.workitem));
        rebased = rebased.filter((c) => matchesWorkitemFilter(c, options.workitem));
    }

    const summaryCommits = [...authored, ...rebased];
    const workitemMap = buildWorkitemSummary(summaryCommits, !!options.stat);
    const rebasedClusters = clusterRebasedByCI(rebased);

    if (authored.length === 0 && rebased.length === 0) {
        out.println(chalk.yellow("\nNo commits found for the specified criteria."));
        return;
    }

    const showAuthor = authors.length !== 1;
    const renderOpts = {
        showBranch,
        showWorkitemId,
        includeStat: !!options.stat,
        showAuthor,
        resetAuthorByHash,
        dateMode,
        groupBy,
    };

    let outputText = "";

    if (options.format === "json") {
        outputJson({
            from: options.from,
            to: options.to,
            authors,
            commits: authored,
            rebasedCommits: rebased,
            workitemSummary: workitemMap,
        });
    } else if (options.markdown) {
        outputText = renderMarkdown(authored, {
            from: options.from,
            to: options.to,
            showBranch,
            showWorkitemId,
            includeStat: !!options.stat,
            groupBy,
            groupingDate: (c) =>
                groupingDateFor(c, dateMode, resetAuthorByHash.get(c.hash) ?? false),
            workitemSummary: workitemMap,
            rebasedClusters,
            includeRebasesExpanded: !!options.includeRebases,
            rebasedExpanded: rebased,
        });

        out.println(outputText);
    } else {
        renderTableMain(authored, {
            groupBy,
            dateMode,
            showBranch,
            showWorkitemId,
            includeStat: !!options.stat,
            showAuthor,
            resetAuthorByHash,
        });

        if (workitemMap.size > 0) {
            out.println(`\n${chalk.bold("Workitem Summary:")}`);

            for (const [id, stats] of [...workitemMap.entries()].sort((a, b) => a[0] - b[0])) {
                const statPart = options.stat
                    ? chalk.dim(` (+${stats.totalInsertions}/-${stats.totalDeletions})`)
                    : "";
                out.println(`  ${chalk.yellow(`#${id}`)} - ${stats.commits} commit(s)${statPart}`);
            }
        }

        if (options.includeRebases) {
            renderRebasedExpanded(rebased, renderOpts);
        } else if (rebased.length > 0) {
            renderRebasedCompressed(rebasedClusters);
        }

        out.println(`\n${chalk.dim(`Total: ${authored.length} commits`)}`);
    }

    if (options.clipboard) {
        if (options.markdown && outputText) {
            await copyToClipboard(outputText);
        } else if (options.format === "json") {
            await copyToClipboard(
                SafeJSON.stringify(
                    {
                        from: options.from,
                        to: options.to,
                        authors,
                        commits: authored,
                        rebasedCommits: rebased,
                    },
                    null,
                    2
                )
            );
        }
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
        .option("--group-by <mode>", "Group commits: day, branch, workitem, or none", "day")
        .option("--without-branch", "Hide inline branch column")
        .option("--without-workitem-id", "Hide inline #workitem column")
        .option("--with-workitem-title", "Resolve workitem titles from Azure DevOps cache")
        .option("--without-stashes", "Exclude stash commits (WIP on / index on)")
        .option("--without-merges", "Exclude merge commits")
        .option(
            "--workitem <id>",
            "Filter to commits referencing workitem ID (repeatable)",
            (v: string, prev: number[] = []) => {
                const parsed = parseInt(v, 10);
                return [...prev, parsed];
            },
            [] as number[]
        )
        .option("--include-rebases", "Expand rebased-into-range commits inline")
        .option("--date <mode>", "Grouping date: author, commit, or true-first", "author")
        .option("--markdown", "Markdown output for standup / time-log paste")
        .option("--clipboard", "Copy output to clipboard")
        .action(async (options: CommitsOptions) => {
            await handleCommits(options);
        });
}
