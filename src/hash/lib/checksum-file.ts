import { algoForTag, type HashAlgo, HEX_LENGTH } from "./algorithms";

export interface ChecksumEntry {
    hex: string;
    path: string;
    line: number;
    /** Set only for a BSD-style tag line (`SHA256 (file) = hex`), which names its own algorithm. */
    algo?: HashAlgo;
}

export type ParsedLine = { kind: "entry"; entry: ChecksumEntry } | { kind: "improper"; line: number };

const PLAIN_LINE = /^[ \t]*(\\?)([0-9a-fA-F]+)[ \t]([ *])(.+)$/s;
const TAG_LINE = /^[ \t]*(\\?)([A-Za-z0-9]+) \((.+)\) = ([0-9a-fA-F]+)/s;

function escapePath(path: string): string {
    return path.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function unescapePath(path: string): string {
    return path.replace(/\\(\\|n)/g, (_match, char: string) => (char === "n" ? "\n" : "\\"));
}

/** `<hex>  <path>`. A path holding a backslash or a newline gets a leading `\` and escaped, as coreutils writes it. */
export function formatChecksumLine(hex: string, path: string): string {
    if (path.includes("\\") || path.includes("\n")) {
        return `\\${hex}  ${escapePath(path)}`;
    }

    return `${hex}  ${path}`;
}

function parseLine(text: string, line: number): ParsedLine | null {
    if (text.startsWith("#")) {
        return null;
    }

    const tag = TAG_LINE.exec(text);
    if (tag !== null) {
        const [, backslash, name, rawPath, hex] = tag;
        const algo = algoForTag(name);
        if (algo === undefined || hex.length !== HEX_LENGTH[algo]) {
            return { kind: "improper", line };
        }

        const path = backslash === "\\" ? unescapePath(rawPath) : rawPath;
        return { kind: "entry", entry: { hex: hex.toLowerCase(), path, line, algo } };
    }

    const plain = PLAIN_LINE.exec(text);
    if (plain === null) {
        return { kind: "improper", line };
    }

    const [, backslash, hex, , rawPath] = plain;
    const path = backslash === "\\" ? unescapePath(rawPath) : rawPath;
    return { kind: "entry", entry: { hex: hex.toLowerCase(), path, line } };
}

/**
 * Reads a checksum file the way `shasum -c` does: `#` at the start of a line is a comment, a line is `hex`, one
 * space or tab, a mode character (a space for text, `*` for binary), then the path, and a path may be `\`-escaped.
 * Any other line, a blank one included, is improperly formatted. A CRLF file keeps its `\r` in the path.
 */
export function parseChecksumLines(text: string): ParsedLine[] {
    const lines = text.split("\n");
    if (lines.at(-1) === "") {
        lines.pop();
    }

    const parsed: ParsedLine[] = [];
    for (const [index, text] of lines.entries()) {
        const result = parseLine(text, index + 1);
        if (result !== null) {
            parsed.push(result);
        }
    }

    return parsed;
}

export function parseChecksumFile(text: string): ChecksumEntry[] {
    const entries: ChecksumEntry[] = [];
    for (const parsed of parseChecksumLines(text)) {
        if (parsed.kind === "entry") {
            entries.push(parsed.entry);
        }
    }

    return entries;
}
