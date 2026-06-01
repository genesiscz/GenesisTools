import { fuzzySearchByHaystack } from "@app/utils/fuzzy-search";
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
        row.commitMessage ?? "",
        row.sessionTitle ?? "",
        row.cwd ?? "",
        row.agent ?? "",
        row.sessionId ?? "",
        row.agentLabel ?? "",
        row.refs.map((x) => `${x.type}:${x.value}`).join(" "),
    ].join(" ");
}

export function searchQa(rows: QaRow[], query: string): SearchResult {
    const { items, tokens } = fuzzySearchByHaystack(rows, query, entryHaystack);

    return { entries: items, tokens };
}
