/**
 * Claude's session titles, read by one rule: a `/rename` appends a `{"type":"custom-title","customTitle":"…"}` row, and
 * the newest such row is the title. `claudeCustomTitleOfRow` is that rule; the reader applies it to every row it
 * parses (`claude.ts`), and the title search (`claude-locate.ts`) finds only the candidate rows in the raw bytes and
 * hands each one to the same function, so a 200 MB transcript is never parsed whole for its title.
 */
import { scanFileMatches } from "@genesiscz/utils/ai/transcripts/file-scan";
import { SafeJSON } from "@genesiscz/utils/json";

/** Where a `/rename` row starts: Claude writes `type` as its first key. */
const CUSTOM_TITLE_ROW = '"type":"custom-title"';

/** Bytes kept after each candidate row's start: a row (so a title) longer than this is not read. */
const TITLE_WINDOW = 4096;

/** The title one parsed Claude row names: a `/rename` row's `customTitle`, else empty. */
export function claudeCustomTitleOfRow(row: Record<string, unknown>): string {
    return row.type === "custom-title" && typeof row.customTitle === "string" ? row.customTitle : "";
}

/** The title of one candidate row's raw text (from its `"type"` key to the window's end), or empty. */
function titleOfCandidate(slice: string): string {
    const end = slice.indexOf("\n");

    try {
        const row: unknown = SafeJSON.parse(`{${end === -1 ? slice : slice.slice(0, end)}`, { strict: true });
        return typeof row === "object" && row !== null && !Array.isArray(row)
            ? claudeCustomTitleOfRow(Object.fromEntries(Object.entries(row)))
            : "";
    } catch {
        // A row cut by the window, or one still being written: it names no title this read can trust.
        return "";
    }
}

/** The last `/rename` title in a Claude transcript's text, or null. */
export function lastClaudeTitle(text: string): string | null {
    let last: string | null = null;
    let at = text.indexOf(CUSTOM_TITLE_ROW);

    while (at !== -1) {
        last = titleOfCandidate(text.slice(at, at + TITLE_WINDOW)) || last;
        at = text.indexOf(CUSTOM_TITLE_ROW, at + CUSTOM_TITLE_ROW.length);
    }

    return last;
}

/** The last `/rename` title of a transcript, streamed: a 200 MB transcript is never one string. */
export function lastClaudeTitleIn(path: string): string | null {
    let last: string | null = null;
    scanFileMatches(path, CUSTOM_TITLE_ROW, TITLE_WINDOW, (slice) => {
        last = titleOfCandidate(slice.toString("utf8")) || last;
    });

    return last;
}
