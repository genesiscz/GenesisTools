/** Claude's session titles: the `custom-title` rows a `/rename` appends. The Claude driver's `locate` part reads them. */
import { scanFileMatches } from "@genesiscz/utils/ai/transcripts/file-scan";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const CUSTOM_TITLE = /"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g;

/** Bytes kept after each `custom-title` match: a title longer than this is not read. */
const TITLE_WINDOW = 4096;

/** The last `/rename` title in a Claude transcript's text, or null. */
export function lastClaudeTitle(text: string): string | null {
    let last: string | null = null;

    for (const match of text.matchAll(CUSTOM_TITLE)) {
        last = match[1];
    }

    if (last === null) {
        return null;
    }

    try {
        const decoded = SafeJSON.parse(`"${last}"`, { strict: true });

        return typeof decoded === "string" ? decoded : last;
    } catch (err) {
        logger.debug({ err }, "[session-title] title escape unreadable; using it raw");
        return last;
    }
}

/** The last `/rename` title of a transcript, streamed: a 200 MB transcript is never one string. */
export function lastClaudeTitleIn(path: string): string | null {
    const found: { last: Buffer | null } = { last: null };
    scanFileMatches(path, '"type":"custom-title","customTitle":"', TITLE_WINDOW, (slice) => {
        found.last = Buffer.from(slice);
    });

    return found.last === null ? null : lastClaudeTitle(found.last.toString("utf8"));
}
