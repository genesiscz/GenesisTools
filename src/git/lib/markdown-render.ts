import type { BranchAttribution } from "@app/git/lib/branch-attribution";
import { formatBranchTag } from "@app/git/lib/branch-attribution";
import { showItems } from "@app/git/lib/format";
import type { RebaseCluster } from "@app/git/lib/rebase-classifier";
import { formatClusterTimestamp, formatYmd } from "@app/git/lib/rebase-classifier";
import { formatDateTime } from "@app/utils/date";

export interface MarkdownCommit {
    hash: string;
    shortHash: string;
    message: string;
    date: string;
    commitDate: string;
    author: string;
    workitemIds: number[];
    insertions?: number;
    deletions?: number;
    branchAttribution?: BranchAttribution;
    workitemTitles?: Map<number, string>;
    resetAuthorMarker?: boolean;
}

export interface MarkdownRenderOptions<T extends MarkdownCommit = MarkdownCommit> {
    from: string;
    to: string;
    showBranch: boolean;
    showWorkitemId: boolean;
    includeStat: boolean;
    groupBy: "day" | "branch" | "workitem" | "none";
    groupingDate: (c: T) => string;
    workitemSummary: Map<number, { commits: number; totalInsertions: number; totalDeletions: number }>;
    rebasedClusters: RebaseCluster<T>[];
    includeRebasesExpanded: boolean;
    rebasedExpanded: T[];
}

function workitemTag(ids: number[], titles: Map<number, string> | undefined, show: boolean): string {
    if (!show || ids.length === 0) {
        return "";
    }

    const parts = ids.map((id) => {
        const title = titles?.get(id);

        if (title) {
            return `**[#${id} — ${title}]**`;
        }

        return `**[#${id}]**`;
    });

    return ` ${parts.join(" ")}`;
}

function branchTag(attribution: BranchAttribution | undefined, show: boolean): string {
    if (!show || !attribution) {
        return "";
    }

    const tag = formatBranchTag(attribution);

    if (!tag) {
        return "";
    }

    return ` _${tag}_`;
}

function formatDayHeader(day: string, count: number): string {
    return `## ${formatDateTime(day, { absolute: "date-long" })} (${count} commits)`;
}

function renderCommitLine<T extends MarkdownCommit>(commit: T, opts: MarkdownRenderOptions<T>): string {
    const marker = commit.resetAuthorMarker ? " (?)" : "";
    const stat =
        opts.includeStat && commit.insertions !== undefined ? ` (+${commit.insertions}/-${commit.deletions})` : "";

    return `- \`${commit.shortHash}\`${marker} ${commit.message}${branchTag(commit.branchAttribution, opts.showBranch)}${workitemTag(commit.workitemIds, commit.workitemTitles, opts.showWorkitemId)}${stat}`;
}

export function renderMarkdown<T extends MarkdownCommit>(commits: T[], options: MarkdownRenderOptions<T>): string {
    const lines: string[] = [];

    if (options.groupBy === "none") {
        const sorted = [...commits].sort((a, b) => options.groupingDate(b).localeCompare(options.groupingDate(a)));

        for (const commit of sorted) {
            lines.push(renderCommitLine(commit, options));
        }
    } else if (options.groupBy === "branch") {
        const groups = groupByKey(commits, (c) => c.branchAttribution?.branch ?? "(detached)");

        for (const [branch, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            lines.push(`## [${branch}] (${group.length} commits)`);
            lines.push("");

            for (const commit of group) {
                lines.push(renderCommitLine(commit, options));
            }

            lines.push("");
        }
    } else if (options.groupBy === "workitem") {
        const groups = groupByKey(commits, (c) =>
            c.workitemIds.length > 0 ? `#${c.workitemIds[0]}` : "[no-workitem]"
        );

        for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            lines.push(`## [${key}] (${group.length} commits)`);
            lines.push("");

            for (const commit of group) {
                lines.push(renderCommitLine(commit, options));
            }

            lines.push("");
        }
    } else {
        const groups = groupByKey(commits, (c) => options.groupingDate(c).split("T")[0]);
        const sortedDays = [...groups.keys()].sort();

        for (const day of sortedDays) {
            const group = groups.get(day)!;
            lines.push(formatDayHeader(day, group.length));
            lines.push("");

            for (const commit of group) {
                lines.push(renderCommitLine(commit, options));
            }

            lines.push("");
        }
    }

    if (options.workitemSummary.size > 0) {
        lines.push("### Workitem summary");
        lines.push("");

        for (const [id, stats] of [...options.workitemSummary.entries()].sort((a, b) => a[0] - b[0])) {
            lines.push(`- **#${id}** — ${stats.commits} commit(s)`);
        }

        lines.push("");
    }

    if (options.includeRebasesExpanded && options.rebasedExpanded.length > 0) {
        lines.push(`### Rebased into range (${options.rebasedExpanded.length})`);
        lines.push("");

        const byDay = groupByKey(options.rebasedExpanded, (c) => c.commitDate.split("T")[0]);

        for (const day of [...byDay.keys()].sort()) {
            lines.push(`#### ${formatDateTime(day, { absolute: "date-long" })}`);
            lines.push("");

            for (const commit of byDay.get(day)!) {
                const authored =
                    commit.date.split("T")[0] !== commit.commitDate.split("T")[0]
                        ? ` [authored ${commit.date.split("T")[0]}]`
                        : "";
                lines.push(`${renderCommitLine(commit, options).replace(/^- /, "- ")}${authored}`);
            }

            lines.push("");
        }
    } else if (options.rebasedClusters.length > 0) {
        const total = options.rebasedClusters.reduce((n, c) => n + c.commits.length, 0);
        lines.push(`### Rebased into range (${total})`);
        lines.push("");
        lines.push(`… and ${total} commits rebased into this range (use --include-rebases):`);
        lines.push("");

        for (const cluster of options.rebasedClusters) {
            const landed = formatClusterTimestamp(cluster.landedAt);
            const from = formatYmd(cluster.authorDateRange[0]);
            const to = formatYmd(cluster.authorDateRange[1]);
            lines.push(`- ${cluster.commits.length} commits rebased ${landed}, authored ${from} – ${to}`);
            lines.push(`  - ${showItems(cluster.commits, (c) => `\`${c.shortHash}\``)}`);
        }
    }

    return lines.join("\n").trimEnd();
}

function groupByKey<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();

    for (const item of items) {
        const key = keyFn(item);
        const list = map.get(key) ?? [];
        list.push(item);
        map.set(key, list);
    }

    return map;
}
