/**
 * Git Commits Command
 *
 * Query commits by date range with author filtering, workitem ID extraction,
 * branch attribution, rebase classification, and optional line change stats.
 */

import { loadConfig } from "@app/azure-devops/config";
import { enrichWorkItems } from "@app/azure-devops/lib/work-item-enrichment";
import { type BranchAttribution, formatBranchTag, resolveBranchForCommits } from "@app/git/lib/branch-attribution";
import { showItems } from "@app/git/lib/format";
import { renderMarkdown } from "@app/git/lib/markdown-render";
import { computePatchIds, dedupByPatchId } from "@app/git/lib/patch-id-dedup";
import {
    classifyCommit,
    clusterRebasedByCI,
    formatClusterTimestamp,
    formatYmd,
    isLikelyResetAuthor,
    type RebaseCluster,
    rangeBoundsMs,
} from "@app/git/lib/rebase-classifier";
import { extractFromMessage, loadWorkitemPatternsAsync } from "@app/git/workitem-patterns";
import { logger, out } from "@app/logger";
import { Executor } from "@app/utils/cli";
import { copyToClipboard } from "@app/utils/clipboard";
import { formatDateTime } from "@app/utils/date";
import type { DetailedCommitInfo } from "@app/utils/git";
import { SafeJSON } from "@app/utils/json";
import { Stopwatch } from "@app/utils/Stopwatch";
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
    withWorkitems?: boolean;
    withFullCommitMessages?: boolean;
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
    /** Full raw commit body (subject + body, multi-line). `message` is its first line. */
    body: string;
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

    return new Set(
        res.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
    );
}

async function loadExcludeTrunks(storage: Storage): Promise<string[]> {
    const configured = await storage.getConfigValue<{ excludeTrunks?: string[] }>("branchAttribution");

    if (configured?.excludeTrunks && configured.excludeTrunks.length > 0) {
        return configured.excludeTrunks;
    }

    return DEFAULT_EXCLUDE_TRUNKS;
}

const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t/;

/**
 * Split a record's trailing `%B + numstat` field into the raw body and the
 * numstat lines. numstat (when `--numstat` is set) is appended after the body,
 * so we peel matching lines off the END — the body may itself contain blank
 * lines and paragraphs, which a forward blank-line split would mishandle.
 */
function splitBodyAndStat(tail: string): { body: string; statLines: string[] } {
    const lines = tail.split("\n");

    // Drop trailing blank lines (git emits one before the next record separator).
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
    }

    const statLines: string[] = [];

    while (lines.length > 0 && NUMSTAT_LINE.test(lines[lines.length - 1])) {
        statLines.unshift(lines.pop()!);
    }

    return { body: lines.join("\n").trim(), statLines };
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

    // %x1e (record separator) prefixes each commit so multi-line %B bodies parse
    // unambiguously; %B is last so trailing numstat lines append cleanly after it.
    const args = [
        "log",
        `--after=${from}`,
        `--before=${toExclusive}`,
        "--all",
        "--pretty=format:%x1e%H%x00%h%x00%an%x00%aI%x00%cI%x00%P%x00%B",
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

    for (const record of result.stdout.split("\x1e")) {
        if (!record.trim()) {
            continue;
        }

        const parts = record.split("\0");

        if (parts.length < 7) {
            continue;
        }

        const [hash, shortHash, author, date, commitDate, parentPart] = parts;
        const tail = parts.slice(6).join("\0");
        const parentCount = parentPart.trim() ? parentPart.trim().split(/\s+/).length : 0;

        const { body, statLines } = splitBodyAndStat(tail);
        const message = body.split("\n", 1)[0];

        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;

        for (const statLine of statLines) {
            const statParts = statLine.split("\t");
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

        commits.push({
            hash,
            shortHash,
            author,
            date,
            commitDate,
            message,
            body,
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

function workitemTag(commit: CommitWithStats, showWorkitemId: boolean): string {
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

function commitBodyContinuation(commit: CommitWithStats): string {
    const rest = commit.body.split("\n").slice(1);

    while (rest.length > 0 && rest[0].trim() === "") {
        rest.shift();
    }

    while (rest.length > 0 && rest[rest.length - 1].trim() === "") {
        rest.pop();
    }

    if (rest.length === 0) {
        return "";
    }

    return `\n${rest.map((line) => chalk.dim(`      ${line}`)).join("\n")}`;
}

function formatCommitRow(
    commit: CommitWithStats,
    opts: {
        showBranch: boolean;
        showWorkitemId: boolean;
        includeStat: boolean;
        showAuthor: boolean;
        showFullMessages?: boolean;
        authoredAnnotation?: string;
    }
): string {
    const marker = commit.resetAuthorMarker ? chalk.dim(" (?)") : "";
    const branch =
        opts.showBranch && commit.branchAttribution ? chalk.dim(` ${formatBranchTag(commit.branchAttribution)}`) : "";
    const stat =
        opts.includeStat && (commit.insertions > 0 || commit.deletions > 0)
            ? chalk.dim(` (${commit.filesChanged} files, +${commit.insertions}/-${commit.deletions})`)
            : "";
    const author = opts.showAuthor ? chalk.dim(` (${commit.author})`) : "";
    const authored = opts.authoredAnnotation ? chalk.dim(` ${opts.authoredAnnotation}`) : "";
    const continuation = opts.showFullMessages ? commitBodyContinuation(commit) : "";

    return `  ${chalk.dim(commit.shortHash)}${marker} ${commit.message}${branch}${workitemTag(commit, opts.showWorkitemId)}${stat}${authored}${author}${continuation}`;
}

function buildWorkitemSummary(
    commits: CommitWithStats[],
    _includeStat: boolean
): Map<number, { commits: number; totalInsertions: number; totalDeletions: number }> {
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
        showFullMessages: boolean;
        resetAuthorByHash: Map<string, boolean>;
        rebasedClusters?: RebaseCluster<CommitWithStats>[];
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
                const dateSuffix = opts.dateMode !== "author" ? chalk.dim(` (${commit.date.split("T")[0]})`) : "";
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

    // Rebased clusters land (committer date) within the range; group them under
    // the day they landed so they sit beside that day's authored commits instead
    // of in a detached footer.
    const clustersByDay = new Map<string, RebaseCluster<CommitWithStats>[]>();

    for (const cluster of opts.rebasedClusters ?? []) {
        const day = formatYmd(cluster.landedAt);
        const list = clustersByDay.get(day) ?? [];
        list.push(cluster);
        clustersByDay.set(day, list);
    }

    const allDays = [...new Set([...groups.keys(), ...clustersByDay.keys()])].sort();

    for (const day of allDays) {
        const dayCommits = groups.get(day) ?? [];
        const dayClusters = clustersByDay.get(day) ?? [];
        const rebasedCount = dayClusters.reduce((sum, c) => sum + c.commits.length, 0);
        const countLabel =
            rebasedCount > 0
                ? `(${dayCommits.length} commits, ${rebasedCount} rebased)`
                : `(${dayCommits.length} commits)`;
        out.println(`\n${chalk.bold.cyan(formatDateForDisplay(day))} ${chalk.dim(countLabel)}`);
        out.println(chalk.dim("─".repeat(80)));

        for (const commit of dayCommits) {
            out.println(formatCommitRow(commit, opts));
        }

        for (const cluster of dayClusters) {
            renderRebasedClusterLine(cluster);
        }
    }
}

function clusterBranchLabel(cluster: RebaseCluster<CommitWithStats>): string {
    const counts = new Map<string, number>();

    for (const commit of cluster.commits) {
        const branch = commit.branchAttribution?.branch;

        if (branch && branch !== "(detached)") {
            counts.set(branch, (counts.get(branch) ?? 0) + 1);
        }
    }

    if (counts.size === 0) {
        return "";
    }

    const [dominant] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const suffix = counts.size > 1 ? " +others" : "";

    return chalk.dim(` [from ${dominant}${suffix}]`);
}

function renderRebasedClusterLine(cluster: RebaseCluster<CommitWithStats>): void {
    const landed = formatClusterTimestamp(cluster.landedAt);
    const from = formatYmd(cluster.authorDateRange[0]);
    const to = formatYmd(cluster.authorDateRange[1]);
    out.println(
        `  ${chalk.cyan("▸")} ${cluster.commits.length} commits rebased ${landed}, authored ${from} – ${to}${clusterBranchLabel(cluster)}`
    );
    out.println(`    ${chalk.dim(`[${showItems(cluster.commits, (c) => c.shortHash)}]`)}`);
}

function renderRebasedCompressed(clusters: RebaseCluster<CommitWithStats>[]): void {
    const total = clusters.reduce((sum, c) => sum + c.commits.length, 0);
    out.println(`\n${chalk.dim(`… and ${total} commits rebased into this range (use --include-rebases):`)}`);

    for (const cluster of clusters) {
        renderRebasedClusterLine(cluster);
    }
}

function renderRebasedExpanded(
    rebased: CommitWithStats[],
    opts: {
        showBranch: boolean;
        showWorkitemId: boolean;
        includeStat: boolean;
        showAuthor: boolean;
        showFullMessages?: boolean;
    }
): void {
    out.println(`\n${chalk.bold(`── Rebased into range (${rebased.length} commits) ──`)}`);

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
            const authoredAnnotation = authoredDay !== landedDay ? `[authored ${authoredDay}]` : undefined;

            out.println(
                formatCommitRow(commit, {
                    ...opts,
                    authoredAnnotation,
                })
            );
        }
    }
}

function buildCommitsJson(payload: {
    from: string;
    to: string;
    authors: string[];
    commits: CommitWithStats[];
    rebasedCommits: CommitWithStats[];
    workitemSummary: Map<number, { commits: number; totalInsertions: number; totalDeletions: number }>;
}): string {
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
        body: c.body,
        author: c.author,
        branch: c.branchAttribution?.branch ?? null,
        trunkFallback: c.branchAttribution?.trunkFallback ?? false,
        filesChanged: c.filesChanged,
        insertions: c.insertions,
        deletions: c.deletions,
        workitemIds: c.workitemIds,
        resetAuthorMarker: c.resetAuthorMarker ?? false,
    });

    return SafeJSON.stringify(
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
    );
}

function outputJson(payload: {
    from: string;
    to: string;
    authors: string[];
    commits: CommitWithStats[];
    rebasedCommits: CommitWithStats[];
    workitemSummary: Map<number, { commits: number; totalInsertions: number; totalDeletions: number }>;
}): void {
    out.println(buildCommitsJson(payload));
}

async function handleCommits(options: CommitsOptions): Promise<void> {
    const { log } = logger.scoped("git:commits");
    const sw = new Stopwatch();
    log.debug({ from: options.from, to: options.to }, "commits: start");

    const storage = new Storage("git");
    const configAuthors = (await storage.getConfigValue<string[]>("authors")) ?? [];
    const patterns = await loadWorkitemPatternsAsync();
    const excludeTrunks = await loadExcludeTrunks(storage);
    log.debug({ lap: sw.lap() }, "commits: config loaded");
    const groupBy = options.groupBy ?? "day";
    const dateMode = options.date ?? "author";
    const showBranch = !options.withoutBranch;
    const showWorkitemId = !options.withoutWorkitemId;
    const withTitles = !!options.withWorkitemTitle || !!options.withWorkitems;
    const showFullMessages = !!options.withFullCommitMessages;

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

    let commits = await getCommitsByDate(options.from, options.to, authors, !!options.stat, !!options.withoutMerges);
    log.debug({ lap: sw.lap(), count: commits.length }, "commits: git log done");

    if (options.withoutStashes) {
        const stashHashes = await loadStashHashes(process.cwd());

        commits = commits.filter(
            (c) => !isStashSubject(c.message) && !stashHashes.has(c.hash) && !stashHashes.has(c.shortHash)
        );
    }

    for (const commit of commits) {
        const refs = extractFromMessage(commit.body, patterns);
        commit.workitemIds = [...new Set(refs.map((r) => r.id))];
    }

    const patchIds = await computePatchIds(
        commits.map((c) => c.hash),
        process.cwd()
    );
    commits = dedupByPatchId(commits, patchIds);
    log.debug({ lap: sw.lap(), afterDedup: commits.length }, "commits: patch-id dedup done");

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

    const branchMap = await resolveBranchForCommits([...workitemBySha.keys()], {
        excludeTrunks,
        workitemBySha,
        cwd: process.cwd(),
    });
    log.debug({ lap: sw.lap(), shas: workitemBySha.size }, "commits: branch attribution done");

    for (const commit of [...authoredInRange, ...rebasedInRange]) {
        commit.branchAttribution = branchMap.get(commit.hash);
    }

    const titlesById = new Map<number, string>();

    if (withTitles) {
        const azureConfig = loadConfig();

        if (!azureConfig) {
            log.debug("commits: --with-workitems set but no Azure DevOps config found; titles skipped");
        } else {
            const allIds = [...new Set([...authoredInRange, ...rebasedInRange].flatMap((c) => c.workitemIds))];
            const enriched = await enrichWorkItems(azureConfig, allIds);

            for (const [id, item] of enriched) {
                if (item.title) {
                    titlesById.set(id, item.title);
                }
            }

            for (const commit of [...authoredInRange, ...rebasedInRange]) {
                const titles = new Map<number, string>();

                for (const id of commit.workitemIds) {
                    const title = titlesById.get(id);

                    if (title) {
                        titles.set(id, title);
                    }
                }

                if (titles.size > 0) {
                    commit.workitemTitles = titles;
                }
            }

            log.debug(
                { lap: sw.lap(), ids: allIds.length, resolved: titlesById.size },
                "commits: workitem titles resolved"
            );
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
        if (options.format === "json") {
            outputJson({
                from: options.from,
                to: options.to,
                authors,
                commits: [],
                rebasedCommits: [],
                workitemSummary: new Map(),
            });
            return;
        }

        if (options.markdown) {
            out.println("");
            return;
        }

        out.println(chalk.yellow("\nNo commits found for the specified criteria."));
        return;
    }

    const showAuthor = authors.length !== 1;
    const renderOpts = {
        showBranch,
        showWorkitemId,
        includeStat: !!options.stat,
        showAuthor,
        showFullMessages,
        resetAuthorByHash,
        dateMode,
        groupBy,
    };

    // Fold rebased clusters into their landed day only in the default day view;
    // other groupings (branch/workitem/none) keep the detached footer.
    const foldClustersIntoDays = groupBy === "day" && !options.includeRebases;
    const anyResetMarker = [...authored, ...rebased].some((c) => c.resetAuthorMarker);

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
            groupingDate: (c) => groupingDateFor(c, dateMode, resetAuthorByHash.get(c.hash) ?? false),
            workitemSummary: workitemMap,
            workitemTitles: titlesById,
            showFullMessages,
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
            showFullMessages,
            resetAuthorByHash,
            rebasedClusters: foldClustersIntoDays ? rebasedClusters : undefined,
        });

        if (workitemMap.size > 0) {
            out.println(`\n${chalk.bold("Workitem Summary:")}`);

            for (const [id, stats] of [...workitemMap.entries()].sort((a, b) => a[0] - b[0])) {
                const statPart = options.stat ? chalk.dim(` (+${stats.totalInsertions}/-${stats.totalDeletions})`) : "";
                const title = titlesById.get(id);
                const titlePart = title ? ` — ${title}` : "";
                out.println(`  ${chalk.yellow(`#${id}${titlePart}`)} - ${stats.commits} commit(s)${statPart}`);
            }
        }

        if (options.includeRebases && rebased.length > 0) {
            renderRebasedExpanded(rebased, renderOpts);
        } else if (!foldClustersIntoDays && rebased.length > 0) {
            renderRebasedCompressed(rebasedClusters);
        }

        out.println(`\n${chalk.dim(`Total: ${authored.length} commits`)}`);

        if (anyResetMarker) {
            out.println(
                chalk.dim(
                    "\n(?) author date ≈ commit date and clustered into one minute — the fingerprint of a rebase/amend that reset the author date. The time shown is likely when it was rebased, not when the work was first written (try --date true-first)."
                )
            );
        }
    }

    if (options.clipboard) {
        if (options.markdown && outputText) {
            await copyToClipboard(outputText);
        } else if (options.format === "json") {
            await copyToClipboard(
                buildCommitsJson({
                    from: options.from,
                    to: options.to,
                    authors,
                    commits: authored,
                    rebasedCommits: rebased,
                    workitemSummary: workitemMap,
                })
            );
        } else {
            out.println(chalk.yellow("\nWarning: Clipboard copy is only supported with --markdown or --format json."));
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
        .option("--with-workitem-title", "Resolve workitem titles from Azure DevOps cache (inline + summary)")
        .option("--with-workitems", "Alias for --with-workitem-title")
        .option("--with-full-commit-messages", "Show full multi-line commit bodies (default: first line only)")
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
