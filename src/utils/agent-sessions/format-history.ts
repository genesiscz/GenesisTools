import { homedir } from "node:os";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { truncateText } from "@genesiscz/utils/string";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";
import { formatSessionAge } from "./session-display";
import type { AgentSearchHit, NativeHistoryEntry } from "./types";

/**
 * What the flags add to a rendering, for the doors that have them.
 *
 * `tools claude history` printed the search MODE in its heading, the relevance score beside each
 * hit and the context size above the context block; the shared renderer named none of them, so
 * `tools codex history --sort-relevance` looked the same as an unsorted listing. Optional, so
 * `run --list` can keep calling with two arguments.
 */
export interface HistoryRenderOptions {
    summaryOnly?: boolean;
    sortByRelevance?: boolean;
    /** `--context <n>`, named in the context heading. */
    context?: number;
}

/** Long enough to judge a hit by, short enough that `--context 5` is still readable. */
const MARKDOWN_TEXT_LIMIT = 500;

function shorten(text: string, limit = MARKDOWN_TEXT_LIMIT): string {
    const flat = text.replace(/\n/g, " ").trim();

    return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function entryLine(entry: NativeHistoryEntry): string {
    const text = shorten(entry.text);

    if (entry.tool) {
        const path = entry.paths[0];

        return `  - **Tool:** ${entry.tool}${path ? ` \`${path}\`` : ""}${text ? ` — ${text}` : ""}`;
    }

    return `**[${entry.role.charAt(0).toUpperCase()}${entry.role.slice(1)}]** ${text}`;
}

/** The commits a hit recorded; the Claude door has always listed them under `--commit`. */
function commitsOf(hit: AgentSearchHit<string>): string[] {
    return [...new Set((hit.matchedEntries ?? []).flatMap((entry) => entry.commits))];
}

export function formatHistoryMarkdown(
    hits: AgentSearchHit<string>[],
    query?: string,
    options: HistoryRenderOptions = {}
): string {
    const q = query ? `"${query}"` : "all";
    const mode = options.summaryOnly ? " (summary-only)" : options.sortByRelevance ? " (by relevance)" : "";
    const lines = [`## Found ${hits.length} conversation${hits.length === 1 ? "" : "s"} matching ${q}${mode}`, ""];

    for (const [index, hit] of hits.entries()) {
        const score =
            options.sortByRelevance && hit.relevanceScore !== undefined ? ` [score: ${hit.relevanceScore}]` : "";
        lines.push(
            `### ${index + 1}. ${hit.title}${hit.project ? ` (${hit.project})` : ""}${hit.isSubagent ? " [Subagent]" : ""}${score}`
        );
        lines.push(
            [
                `**Date:** ${hit.mtime.toISOString().slice(0, 10)}`,
                `**Kind:** ${hit.kind}`,
                ...(hit.gitBranch ? [`**Branch:** ${hit.gitBranch}`] : []),
            ].join(" | ")
        );
        lines.push(`**Session ID:** \`${hit.sessionId}\``);
        lines.push(`**Cwd:** \`${hit.cwd}\``);

        if (hit.summary && hit.summary !== hit.title) {
            lines.push(`**Summary:** ${hit.summary}`);
        }

        if (hit.account) {
            lines.push(`**Account:** ${hit.account}`);
        }

        if (hit.sourceHome) {
            lines.push(`**Source home:** \`${hit.sourceHome}\``);
        }

        if (hit.archived) {
            lines.push("**Archived:** yes");
        }

        const commits = commitsOf(hit);

        if (commits.length > 0) {
            const shown = commits.slice(0, 5).map((hash) => `\`${hash.slice(0, 7)}\``);
            lines.push(`**Commits:** ${shown.join(", ")}${commits.length > 5 ? "..." : ""}`);
        }

        lines.push(`**File:** \`${hit.filePath.replace(homedir(), "~")}\``);

        const context = hit.contextEntries ?? [];

        if (context.length > 0) {
            lines.push("");
            const size = options.context
                ? ` (${options.context} message${options.context === 1 ? "" : "s"} before/after match)`
                : "";
            lines.push(`#### Context${size}`);
            lines.push("");

            for (const entry of context) {
                lines.push(entryLine(entry));
                lines.push("");
            }
        }

        if (hit.matchedText) {
            lines.push("");
            lines.push(hit.matchedText.replace(/\n/g, " ").trim());
        }

        lines.push("");
    }

    return lines.join("\n");
}

/** One tool result held 861,027 characters, which is why five codex hits weighed 13,434,868 bytes. */
const JSON_ENTRY_TEXT_LIMIT = 1200;
// 20 matches the relevance counter's own ceiling. The markdown door stays uncapped, so `--context`
// still renders in full for a human; only the machine payload is bounded, and it says when it cut.
const JSON_ENTRY_LIMIT = 20;

/**
 * `matchedText` was capped at 1,200 characters but the entries beside it were not, in count or in
 * size, so `codex history "Zayo" --limit 50 --json` reached 43,189,156 bytes against base grok's
 * 3,273 for the same shape. A truncated field says so, so a consumer can tell a cut from an end.
 */
function boundedEntries(entries: NativeHistoryEntry[] | undefined) {
    if (!entries) {
        return undefined;
    }

    return entries.slice(0, JSON_ENTRY_LIMIT).map((entry) => {
        const truncated = entry.text.length > JSON_ENTRY_TEXT_LIMIT;

        return {
            ...entry,
            text: truncated ? entry.text.slice(0, JSON_ENTRY_TEXT_LIMIT) : entry.text,
            ...(truncated ? { textTruncated: true } : {}),
            ...(entry.searchText && entry.searchText.length > JSON_ENTRY_TEXT_LIMIT
                ? { searchText: entry.searchText.slice(0, JSON_ENTRY_TEXT_LIMIT), searchTextTruncated: true }
                : {}),
            ...(entry.inputText && entry.inputText.length > JSON_ENTRY_TEXT_LIMIT
                ? { inputText: entry.inputText.slice(0, JSON_ENTRY_TEXT_LIMIT), inputTextTruncated: true }
                : {}),
        };
    });
}

/**
 * Always a bare array. An earlier draft wrapped it in an object carrying the unfinished-migration
 * count, but only when something was pending, so the shape depended on the data: `cmd --json |
 * jq '.[]'` would silently start iterating an object's values instead of failing. A shape that
 * changes exactly when something is already wrong is the worst moment to surprise a consumer, and
 * the condition is transitional — one `history index` clears it — so it does not deserve
 * permanent API. Humans get the warning on stderr from every door, including `resume`.
 */
export function formatHistoryJson(hits: AgentSearchHit<string>[]): string {
    return `${SafeJSON.stringify(
        hits.map((hit) => {
            const commits = commitsOf(hit);

            return {
                kind: hit.kind,
                sessionId: hit.sessionId,
                title: hit.title,
                cwd: hit.cwd,
                project: hit.project,
                gitBranch: hit.gitBranch,
                ...(commits.length > 0 ? { commitHashes: commits } : {}),
                mtime: hit.mtime.toISOString(),
                matchedText: hit.matchedText,
                filePath: hit.filePath,
                sourceHome: hit.sourceHome,
                sourceKey: hit.sourceKey,
                account: hit.account,
                summary: hit.summary,
                archived: hit.archived,
                isSubagent: hit.isSubagent,
                relevanceScore: hit.relevanceScore,
                matchedEntries: boundedEntries(hit.matchedEntries),
                contextEntries: boundedEntries(hit.contextEntries),
                ...((hit.matchedEntries?.length ?? 0) > JSON_ENTRY_LIMIT
                    ? { matchedEntriesTruncatedFrom: hit.matchedEntries!.length }
                    : {}),
            };
        }),
        null,
        2
    )}\n`;
}

export function renderHistoryTable(
    hits: AgentSearchHit<string>[],
    query?: string,
    options: HistoryRenderOptions = {}
): void {
    renderCliHeader("History", query ? `matching "${query}"` : "recent sessions");

    // Two columns that only earn their width when they can tell rows apart: a match snippet,
    // which a plain listing has none of, and a source home, which only disambiguates when the
    // hits actually span several homes.
    const matched = hits.some((hit) => hit.matchedText);
    const sourced = new Set(hits.map((hit) => hit.sourceHome).filter(Boolean)).size > 1;
    const table = createBoxTable([
        "ID",
        "PROJECT",
        "TITLE",
        ...(matched ? ["MATCH"] : []),
        "BRANCH",
        "AGE",
        "STATUS",
        ...(sourced ? ["SOURCE"] : []),
    ]);

    for (const hit of hits) {
        const project = (hit.project ?? "").trim();
        table.push([
            pc.white(pc.bold(hit.sessionId)),
            project ? pc.blue(truncateText(project, 18)) : pc.dim("—"),
            pc.white(truncateText(hit.title, 36)),
            ...(matched ? [truncateDisplay(hit.matchedText?.replace(/\s+/g, " ").trim() ?? "", 60)] : []),
            hit.gitBranch ? pc.magenta(truncateText(hit.gitBranch, 18)) : pc.dim("—"),
            formatSessionAge(hit.mtime.toISOString()),
            hit.isSubagent ? formatDotStatus("dim", "agent") : formatDotStatus("ok", "main"),
            ...(sourced ? [pc.dim(truncateText(hit.sourceHome ?? "native", 24))] : []),
        ]);
    }

    out.println(table.toString());
    out.println();
    out.println(
        `  ${[
            pc.dim(`${hits.length} result${hits.length === 1 ? "" : "s"}`),
            options.sortByRelevance ? pc.dim("sorted by relevance") : "",
            options.summaryOnly ? pc.dim("summary-only") : "",
        ]
            .filter(Boolean)
            .join(pc.dim("  ·  "))}`
    );
    out.println();
}
