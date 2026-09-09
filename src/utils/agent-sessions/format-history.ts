import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import type { AgentSearchHit, NativeHistoryEntry } from "./types";

export function formatHistoryMarkdown(hits: AgentSearchHit<string>[], query?: string): string {
    const q = query ? `"${query}"` : "all";
    const lines = [`## Found ${hits.length} conversation${hits.length === 1 ? "" : "s"} matching ${q}`, ""];

    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const date = hit.mtime.toISOString().slice(0, 10);
        lines.push(`### ${i + 1}. ${hit.title}`);
        lines.push(`**Date:** ${date} | **Kind:** ${hit.kind} | **Session ID:** \`${hit.sessionId}\``);
        lines.push(`**Cwd:** \`${hit.cwd}\``);
        if (hit.sourceHome) {
            lines.push(`**Source home:** \`${hit.sourceHome}\``);
        }
        if (hit.account) {
            lines.push(`**Account:** ${hit.account}`);
        }
        if (hit.archived) {
            lines.push("**Archived:** yes");
        }
        if (hit.isSubagent) {
            lines.push("**Subagent:** yes");
        }
        for (const entry of hit.contextEntries ?? []) {
            lines.push(`**[${entry.role}${entry.tool ? `: ${entry.tool}` : ""}]** ${entry.text}`);
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
        hits.map((hit) => ({
            kind: hit.kind,
            sessionId: hit.sessionId,
            title: hit.title,
            cwd: hit.cwd,
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
        })),
        null,
        2
    )}\n`;
}

export function renderHistoryTable(hits: AgentSearchHit<string>[]): void {
    // A search whose table shows no matched text gives the reader nothing to judge the hit by,
    // which is the one thing the markdown form always printed. Only add the column when a hit
    // actually carries a snippet, so a plain listing keeps the narrow table.
    const matched = hits.some((hit) => hit.matchedText);
    const table = createBoxTable(
        matched
            ? ["Session", "Title", "Match", "Project", "Updated", "Source"]
            : ["Session", "Title", "Project", "Updated", "Source"]
    );
    for (const hit of hits) {
        table.push([
            hit.sessionId.slice(0, 12),
            hit.title,
            ...(matched ? [truncateDisplay(hit.matchedText?.replace(/\s+/g, " ").trim() ?? "", 60)] : []),
            hit.project ?? hit.cwd,
            hit.mtime.toISOString().slice(0, 10),
            hit.sourceHome ?? "native",
        ]);
    }
    out.println(table.toString());
}
