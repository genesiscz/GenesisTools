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
    body?: string;
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
    workitemTitles?: Map<number, string>;
    showFullMessages?: boolean;
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

function bodyContinuation(commit: MarkdownCommit): string {
    if (!commit.body) {
        return "";
    }

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

    return `\n${rest.map((line) => `  ${line}`).join("\n")}`;
}

function renderCommitLine<T extends MarkdownCommit>(commit: T, opts: MarkdownRenderOptions<T>): string {
    const marker = commit.resetAuthorMarker ? " (?)" : "";
    const stat =
        opts.includeStat && commit.insertions !== undefined ? ` (+${commit.insertions}/-${commit.deletions})` : "";
    const continuation = opts.showFullMessages ? bodyContinuation(commit) : "";

    return `- \`${commit.shortHash}\`${marker} ${commit.message}${branchTag(commit.branchAttribution, opts.showBranch)}${workitemTag(commit.workitemIds, commit.workitemTitles, opts.showWorkitemId)}${stat}${continuation}`;
}

function clusterBranchLabel<T extends MarkdownCommit>(cluster: RebaseCluster<T>): string {
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

    return ` _[from ${dominant}${suffix}]_`;
}

function clusterLine<T extends MarkdownCommit>(cluster: RebaseCluster<T>): string[] {
    const landed = formatClusterTimestamp(cluster.landedAt);
    const from = formatYmd(cluster.authorDateRange[0]);
    const to = formatYmd(cluster.authorDateRange[1]);

    return [
        `- ▸ ${cluster.commits.length} commits rebased ${landed}, authored ${from} – ${to}${clusterBranchLabel(cluster)}`,
        `  - ${showItems(cluster.commits, (c) => `\`${c.shortHash}\``)}`,
    ];
}

export function renderMarkdown<T extends MarkdownCommit>(commits: T[], options: MarkdownRenderOptions<T>): string {
    const lines: string[] = [];
    const foldClustersIntoDays = options.groupBy === "day" && !options.includeRebasesExpanded;

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
        const clustersByDay = new Map<string, RebaseCluster<T>[]>();

        if (foldClustersIntoDays) {
            for (const cluster of options.rebasedClusters) {
                const day = formatYmd(cluster.landedAt);
                const list = clustersByDay.get(day) ?? [];
                list.push(cluster);
                clustersByDay.set(day, list);
            }
        }

        const sortedDays = [...new Set([...groups.keys(), ...clustersByDay.keys()])].sort();

        for (const day of sortedDays) {
            const group = groups.get(day) ?? [];
            const dayClusters = clustersByDay.get(day) ?? [];
            const rebasedCount = dayClusters.reduce((sum, c) => sum + c.commits.length, 0);
            const header =
                rebasedCount > 0
                    ? `${formatDayHeader(day, group.length).replace(/\)$/, `, ${rebasedCount} rebased)`)}`
                    : formatDayHeader(day, group.length);
            lines.push(header);
            lines.push("");

            for (const commit of group) {
                lines.push(renderCommitLine(commit, options));
            }

            for (const cluster of dayClusters) {
                lines.push(...clusterLine(cluster));
            }

            lines.push("");
        }
    }

    if (options.workitemSummary.size > 0) {
        lines.push("### Workitem summary");
        lines.push("");

        for (const [id, stats] of [...options.workitemSummary.entries()].sort((a, b) => a[0] - b[0])) {
            const title = options.workitemTitles?.get(id);
            const titlePart = title ? ` — ${title}` : "";
            lines.push(`- **#${id}${titlePart}** — ${stats.commits} commit(s)`);
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
    } else if (!foldClustersIntoDays && options.rebasedClusters.length > 0) {
        const total = options.rebasedClusters.reduce((n, c) => n + c.commits.length, 0);
        lines.push(`### Rebased into range (${total})`);
        lines.push("");
        lines.push(`… and ${total} commits rebased into this range (use --include-rebases):`);
        lines.push("");

        for (const cluster of options.rebasedClusters) {
            lines.push(...clusterLine(cluster));
        }
    }

    const anyResetMarker =
        commits.some((c) => c.resetAuthorMarker) || options.rebasedExpanded.some((c) => c.resetAuthorMarker);

    if (anyResetMarker) {
        lines.push("");
        lines.push(
            "> `(?)` author date ≈ commit date and clustered into one minute — the fingerprint of a rebase/amend that reset the author date. The time shown is likely when it was rebased, not when the work was first written (try `--date true-first`)."
        );
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
