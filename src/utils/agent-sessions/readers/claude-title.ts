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

/** Bytes kept after each candidate row's start: a title whose field ends past this is not read. */
const TITLE_WINDOW = 4096;

/** The `customTitle` field of a row's raw text, its value a JSON string literal. */
const CUSTOM_TITLE_FIELD = /"customTitle":("(?:[^"\\]|\\.)*")/;

/** The title one parsed Claude row names: a `/rename` row's `customTitle`, else empty. */
export function claudeCustomTitleOfRow(row: Record<string, unknown>): string {
    return row.type === "custom-title" && typeof row.customTitle === "string" ? row.customTitle : "";
}

/**
 * The title of one candidate row's raw text (from its `"type"` key to the window's end), or empty. A whole row is
 * parsed by the row rule; a row the window cuts (a long one, or one still being written) still names its title when
 * the `customTitle` field itself ends inside the window, so that field is decoded on its own.
 */
function titleOfCandidate(slice: string): string {
    const end = slice.indexOf("\n");
    const text = end === -1 ? slice : slice.slice(0, end);

    try {
        const row: unknown = SafeJSON.parse(`{${text}`, { strict: true });
        return typeof row === "object" && row !== null && !Array.isArray(row)
            ? claudeCustomTitleOfRow(Object.fromEntries(Object.entries(row)))
            : "";
    } catch {
        // The row is cut by the window: its title field may still be whole.
        return titleFieldOf(text);
    }
}

/** The decoded `customTitle` of a cut row's text, or empty when the field does not end inside it. */
function titleFieldOf(text: string): string {
    const literal = CUSTOM_TITLE_FIELD.exec(text)?.[1];

    if (!literal) {
        return "";
    }

    try {
        const title: unknown = SafeJSON.parse(literal, { strict: true });
        return typeof title === "string" ? title : "";
    } catch {
        // A literal the pattern matched always decodes; a broken escape names no title this read can trust.
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
