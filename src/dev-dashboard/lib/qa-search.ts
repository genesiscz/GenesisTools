import { scoreEntry, tokenizeSearch } from "@app/utils/fuzzy-tokens";
import type { QaRow } from "./qa-types";

export interface SearchResult {
    entries: QaRow[];
    tokens: string[];
}

function entryHaystack(row: QaRow): string {
    return [
        row.question,
        row.answerMd,
        row.tag,
        row.project ?? "",
        row.branch ?? "",
        row.commitSha ?? "",
        row.agentLabel ?? "",
        row.refs.map((x) => `${x.type}:${x.value}`).join(" "),
    ].join(" ");
}

export function searchQa(rows: QaRow[], query: string): SearchResult {
    const tokens = tokenizeSearch(query);

    if (tokens.length === 0) {
        return { entries: rows, tokens: [] };
    }

    const entries = rows
        .map((entry) => ({ entry, score: scoreEntry(entryHaystack(entry), tokens) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.entry);

    return { entries, tokens };
}
