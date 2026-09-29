import { stripAnsi } from "@genesiscz/utils/string";

/** clack's frame and marker glyphs at the start of a line (`│ ■ link used up`). */
const CLI_DECORATION = /^[\s│┃|◆◇●○■□▲△▪•└┌├─╭╮╰╯┊]+/u;

/**
 * The end of a child's output as a card can show it: no colour codes, no clack frame glyphs, no
 * blank lines, at most `max` characters (the end is kept: that is where the reason is).
 */
export function cliTail(text: string, max = 300): string {
    const lines = stripAnsi(text)
        .split("\n")
        .map((line) => line.replace(CLI_DECORATION, "").trimEnd())
        .filter((line) => line.trim().length > 0);
    const joined = lines.join("\n");
    return joined.length > max ? `…${joined.slice(-max)}` : joined;
}

/** Why a feature refused or failed, as a stable code the extension can show a state for. */
export type FeatureErrorCode = "invalid" | "no-checkout" | "unavailable" | "failed";

export class FeatureError extends Error {
    constructor(
        readonly code: FeatureErrorCode,
        message: string
    ) {
        super(message);
        this.name = "FeatureError";
    }
}
