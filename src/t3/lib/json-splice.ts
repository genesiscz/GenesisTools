import { SafeJSON } from "@genesiscz/utils/json";

/**
 * Byte-preserving edits of one JSON object member. T3 Code owns `settings.json`, so an edit here replaces or inserts
 * exactly one member's text and leaves every other byte as it was: key order, indentation, number spelling and the
 * trailing newline. Re-serializing the whole file would reorder integer-like keys and respell numbers.
 *
 * The scanner reads strict JSON only (no comments, no trailing commas). The caller parses the file strictly first, so
 * a file the scanner cannot read never reaches it.
 */

export interface MemberSpan {
    key: string;
    /** Index of the opening quote of the key. */
    keyStart: number;
    valueStart: number;
    /** One past the last character of the value. */
    valueEnd: number;
}

export interface ObjectSpan {
    /** Index of `{`. */
    open: number;
    /** Index of `}`. */
    close: number;
    members: MemberSpan[];
}

function skipWhitespace(text: string, index: number): number {
    let at = index;

    while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\n" || text[at] === "\r")) {
        at++;
    }

    return at;
}

/** Index one past the closing quote of the string that opens at `start`. */
function stringEnd(text: string, start: number): number {
    let at = start + 1;

    while (at < text.length) {
        const char = text[at];

        if (char === "\\") {
            at += 2;
            continue;
        }

        if (char === '"') {
            return at + 1;
        }

        at++;
    }

    throw new Error(`Unterminated JSON string at offset ${start}.`);
}

/** Index one past the end of the JSON value that starts at `start` (after whitespace). */
function valueEnd(text: string, start: number): number {
    const first = text[start];

    if (first === '"') {
        return stringEnd(text, start);
    }

    if (first === "{" || first === "[") {
        let depth = 0;
        let at = start;

        while (at < text.length) {
            const char = text[at];

            if (char === '"') {
                at = stringEnd(text, at);
                continue;
            }

            if (char === "{" || char === "[") {
                depth++;
            } else if (char === "}" || char === "]") {
                depth--;

                if (depth === 0) {
                    return at + 1;
                }
            }

            at++;
        }

        throw new Error(`Unterminated JSON container at offset ${start}.`);
    }

    let at = start;

    while (at < text.length && !/[\s,}\]]/.test(text[at])) {
        at++;
    }

    if (at === start) {
        throw new Error(`Expected a JSON value at offset ${start}.`);
    }

    return at;
}

/** The members of the object whose `{` is at `open`, with their text spans. */
export function scanObject(text: string, open: number): ObjectSpan {
    if (text[open] !== "{") {
        throw new Error(`Expected "{" at offset ${open}.`);
    }

    const members: MemberSpan[] = [];
    let at = skipWhitespace(text, open + 1);

    if (text[at] === "}") {
        return { open, close: at, members };
    }

    while (at < text.length) {
        if (text[at] !== '"') {
            throw new Error(`Expected a key at offset ${at}.`);
        }

        const keyStart = at;
        const keyEnd = stringEnd(text, at);
        const key = String(SafeJSON.parse(text.slice(keyStart, keyEnd), { strict: true }));
        at = skipWhitespace(text, keyEnd);

        if (text[at] !== ":") {
            throw new Error(`Expected ":" at offset ${at}.`);
        }

        const valueStart = skipWhitespace(text, at + 1);
        const end = valueEnd(text, valueStart);
        members.push({ key, keyStart, valueStart, valueEnd: end });
        at = skipWhitespace(text, end);

        if (text[at] === ",") {
            at = skipWhitespace(text, at + 1);
            continue;
        }

        if (text[at] === "}") {
            return { open, close: at, members };
        }

        throw new Error(`Expected "," or "}" at offset ${at}.`);
    }

    throw new Error(`Unterminated JSON object at offset ${open}.`);
}

/** The root object of a JSON document. */
export function scanRoot(text: string): ObjectSpan {
    return scanObject(text, skipWhitespace(text, 0));
}

/** The whitespace one nesting level adds, read off the root's first member; two spaces when the root is empty. */
export function detectIndentUnit(text: string): string {
    const root = scanRoot(text);
    const first = root.members[0];

    if (!first) {
        return "  ";
    }

    const lineStart = text.lastIndexOf("\n", first.keyStart) + 1;
    const unit = text.slice(lineStart, first.keyStart);

    return /^[ \t]+$/.test(unit) ? unit : "  ";
}

/** `value` as pretty JSON whose continuation lines sit `depth` levels deep. */
export function serializeAt(value: unknown, unit: string, depth: number): string {
    const pretty = SafeJSON.stringify(value, { strict: true }, unit);

    return pretty.replace(/\n/g, `\n${unit.repeat(depth)}`);
}

/**
 * Sets `key` to `value` inside the object whose `{` is at `open`, `depth` levels deep. An existing member keeps its
 * key text and position, and only its value text is replaced. A new member goes after the last one.
 */
export function upsertMember(input: {
    text: string;
    open: number;
    depth: number;
    key: string;
    value: unknown;
    unit: string;
}): string {
    const { text, open, depth, key, unit } = input;
    const object = scanObject(text, open);
    const existing = object.members.find((member) => member.key === key);
    const valueText = serializeAt(input.value, unit, depth + 1);

    if (existing) {
        return text.slice(0, existing.valueStart) + valueText + text.slice(existing.valueEnd);
    }

    const memberText = `${SafeJSON.stringify(key, { strict: true })}: ${valueText}`;
    const last = object.members.at(-1);

    if (!last) {
        const inner = `\n${unit.repeat(depth + 1)}${memberText}\n${unit.repeat(depth)}`;
        return text.slice(0, object.open + 1) + inner + text.slice(object.close);
    }

    // Copy the separator the file already uses between members, so a one-line object stays on one line.
    const previous = object.members.at(-2);
    const separator = previous ? text.slice(previous.valueEnd, last.keyStart) : `,\n${unit.repeat(depth + 1)}`;

    return text.slice(0, last.valueEnd) + separator + memberText + text.slice(last.valueEnd);
}
