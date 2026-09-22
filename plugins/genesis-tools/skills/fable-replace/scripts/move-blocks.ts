/**
 * fable-replace — MOVE a block of code from one file to another.
 *
 * Moving code by hand costs the body twice: once to delete it, once to retype it where it now
 * lives, and a single transcription slip turns a move into a rewrite nobody reviewed. A move names
 * the block instead, so the text is never authored again: it is cut from the source and pasted
 * into the target byte for byte.
 *
 * A move expands into ordinary file edits before the sweep engine runs, so it inherits everything
 * that engine already guarantees: one backup, all-or-nothing writes, the post-edit syntax check,
 * and the same report.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileEdit, Op } from "./types";

/**
 * Where the moved block lands in the target file.
 *
 * There is no `"start"`: the sweep engine has no prepend op, so a top-of-file placement can
 * only be expressed as `{ before: "<first declaration>" }`. Advertising `"start"` and
 * silently appending instead is worse than not offering it.
 */
export type MoveAnchor = "end" | { after: string } | { before: string };

export interface MoveSpec {
    /** File the block is cut from. */
    from: string;
    /**
     * File the block is pasted into. Must differ from `from`.
     *
     * A same-file move is rejected rather than supported: the cut edit asserts the block text
     * is `absentAfter`, and a paste back into the same file would make that assertion fail on
     * every move. Reordering inside one file is an ordinary `block` op, not a move.
     */
    to: string;
    /**
     * Name the block by its declaration: `actOnSurface`, `ListenView`, `NativeControlDriver`.
     * The whole declaration moves, including the doc comment directly above it.
     */
    symbol?: string;
    /** Or name it by 1-indexed inclusive line numbers, when it is not a single declaration. */
    lines?: [number, number];
    /** Or by the first line that contains `start` through the first later line containing `end`. */
    between?: { start: string; end: string };
    /** Default `end`. */
    at?: MoveAnchor;
    /** Content for `to` when it does not exist yet; the block is appended to it. */
    createWith?: string;
    label?: string;
}

export interface LocatedBlock {
    /** 0-indexed, inclusive. */
    start: number;
    /** 0-indexed, inclusive. */
    end: number;
    text: string;
}

const DECLARATION = (symbol: string): RegExp =>
    new RegExp(
        `^\\s*(?:export\\s+)?(?:default\\s+)?(?:public\\s+|private\\s+|internal\\s+|fileprivate\\s+)?` +
            `(?:async\\s+)?(?:static\\s+)?` +
            `(?:function|class|interface|type|enum|struct|extension|protocol|const|let|var|func)\\s+` +
            `${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
    );

/**
 * Characters after which a `/` opens a regular-expression literal rather than dividing.
 *
 * `""` covers the start of a line. Anything else (a letter, a digit, `)`, `]`) means the `/`
 * follows a value, so it is division.
 */
const REGEX_MAY_FOLLOW = new Set([
    "",
    "(",
    ",",
    "=",
    ":",
    "[",
    "!",
    "&",
    "|",
    "?",
    "{",
    "}",
    ";",
    "+",
    "-",
    "*",
    "%",
    "~",
    "^",
    "<",
    ">",
]);

/**
 * Index of the `/` that closes the regular-expression literal opening at `start`.
 *
 * Returns -1 when the literal does not close on this line, in which case the caller treats
 * the `/` as ordinary code. A `/` inside a `[...]` character class does not close it.
 */
function regexLiteralEnd(line: string, start: number): number {
    let inClass = false;

    for (let i = start + 1; i < line.length; i++) {
        const char = line[i];

        if (char === "\\") {
            i++;
            continue;
        }

        if (char === "[") {
            inClass = true;
        } else if (char === "]") {
            inClass = false;
        } else if (char === "/" && !inClass) {
            return i;
        }
    }

    return -1;
}

/**
 * The line where the block that starts at `from` closes.
 *
 * Counts brackets while skipping the places a bracket is not code: line comments, block comments,
 * single and double quoted strings, template literals, and regular-expression literals. A naive
 * depth count reads the `{` in `"a { b"` as an opening brace and then takes the rest of the file
 * with it, which is exactly the failure that makes an automated move untrustworthy.
 */
export function blockEndLine(lines: string[], from: number): number {
    let depth = 0;
    let opened = false;
    let inBlockComment = false;
    let inTemplate = false;
    for (let index = from; index < lines.length; index++) {
        const line = lines[index];
        let quote: string | null = null;
        /** Last non-whitespace code character, which decides whether `/` divides or opens a regex. */
        let previous = "";
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const next = line[i + 1];
            if (inBlockComment) {
                if (char === "*" && next === "/") {
                    inBlockComment = false;
                    i++;
                }
                continue;
            }

            if (quote !== null) {
                if (char === "\\") {
                    i++;
                } else if (char === quote) {
                    quote = null;
                }
                continue;
            }

            if (inTemplate) {
                if (char === "\\") {
                    i++;
                } else if (char === "`") {
                    inTemplate = false;
                }
                continue;
            }

            if (char === "/" && next === "/") {
                break;
            }

            if (char === "/" && next === "*") {
                inBlockComment = true;
                i++;
                continue;
            }

            // A regular-expression literal can carry an unbalanced brace: `const p = /}/;`
            // would otherwise close the block early and the move would cut the wrong span.
            // Only a `/` in expression position opens one; after a value it is division.
            // ⚠️ The test is the previous character, so `return /}/` is not covered — a
            // keyword ends in a letter, which reads as a value here.
            if (char === "/" && REGEX_MAY_FOLLOW.has(previous)) {
                const end = regexLiteralEnd(line, i);

                if (end !== -1) {
                    i = end;
                    previous = ")";
                    continue;
                }
            }

            if (char === '"' || char === "'") {
                quote = char;
                previous = char;
                continue;
            }

            if (char === "`") {
                inTemplate = true;
                previous = char;
                continue;
            }

            // Only braces delimit a block. A signature's own parentheses balance on the
            // declaration line, so counting them ended every function at its first `)`.
            if (char === "{") {
                depth++;
                opened = true;
                previous = char;
                continue;
            }

            if (char === "}") {
                depth--;
                if (opened && depth <= 0) {
                    return index;
                }
            }

            if (char.trim() !== "") {
                previous = char;
            }
        }

        // A declaration with no bracket at all ends on its own line: `type Id = string;`
        if (!opened && !inBlockComment && !inTemplate && quote === null && line.trimEnd().endsWith(";")) {
            return index;
        }
    }

    return -1;
}

/** The first line of the doc comment attached directly above `line`, or `line` itself. */
export function docCommentStart(lines: string[], line: number): number {
    let index = line - 1;

    // A blank line directly above means nothing is attached to this block. This was a `while`
    // whose body returned unconditionally, so it never looped and read as a broken scan; `if`
    // states the same behaviour honestly.
    if (index >= 0 && lines[index].trim().length === 0) {
        return line;
    }

    if (index < 0 || !lines[index].trim().endsWith("*/")) {
        // A run of `//` lines counts as the block's own comment too.
        let first = line;
        while (first - 1 >= 0 && lines[first - 1].trim().startsWith("//")) {
            first--;
        }
        return first;
    }

    while (index >= 0 && !lines[index].trim().startsWith("/*")) {
        index--;
    }

    return index < 0 ? line : index;
}

/** Find the block a spec names. Throws with a reason rather than guessing. */
export function locateBlock(source: string, spec: MoveSpec): LocatedBlock {
    const lines = source.split("\n");
    const slice = (start: number, end: number): LocatedBlock => ({
        start,
        end,
        text: lines.slice(start, end + 1).join("\n"),
    });

    if (spec.lines) {
        const [start, end] = spec.lines;
        if (start < 1 || end < start || end > lines.length) {
            throw new Error(`move: lines ${start}..${end} are outside ${spec.from} (${lines.length} lines)`);
        }

        return slice(start - 1, end - 1);
    }

    if (spec.between) {
        const start = lines.findIndex((line) => line.includes(spec.between?.start ?? ""));
        if (start === -1) {
            throw new Error(`move: no line of ${spec.from} contains the start marker ${spec.between.start}`);
        }

        const offset = lines.slice(start + 1).findIndex((line) => line.includes(spec.between?.end ?? ""));
        if (offset === -1) {
            throw new Error(`move: no line after the start marker contains the end marker ${spec.between.end}`);
        }

        return slice(start, start + 1 + offset);
    }

    if (!spec.symbol) {
        throw new Error("move: name the block with `symbol`, `lines` or `between`");
    }

    const pattern = DECLARATION(spec.symbol);
    const matches = lines.map((line, index) => (pattern.test(line) ? index : -1)).filter((index) => index !== -1);
    if (matches.length === 0) {
        throw new Error(`move: no declaration of ${spec.symbol} in ${spec.from}`);
    }

    if (matches.length > 1) {
        const where = matches.map((index) => index + 1).join(", ");
        throw new Error(`move: ${spec.symbol} is declared more than once in ${spec.from} (lines ${where})`);
    }

    const declared = matches[0];
    const end = blockEndLine(lines, declared);
    if (end === -1) {
        throw new Error(`move: ${spec.symbol} in ${spec.from} is never closed; the file may be malformed`);
    }

    return slice(docCommentStart(lines, declared), end);
}

/** Turn moves into the file edits the sweep engine already knows how to run atomically. */
export function expandMoves(moves: MoveSpec[], options: { cwd?: string } = {}): FileEdit[] {
    const cwd = options.cwd ?? process.cwd();
    const read = (file: string): string => fs.readFileSync(path.resolve(cwd, file), "utf8");
    const edits: FileEdit[] = [];
    for (const move of moves) {
        if (move.from === move.to) {
            throw new Error(
                "move: `from` and `to` are the same file. A move is a cut plus a paste, and the cut asserts the block is gone, which a paste back into the same file would contradict. Reorder within one file with a `block` op instead."
            );
        }

        const source = read(move.from);
        const block = locateBlock(source, move);
        const label = move.label ?? `move ${move.symbol ?? `${block.start + 1}..${block.end + 1}`}`;
        // Take one blank line with the block when it is followed by one, so a move does not leave a
        // widening gap behind every time something is lifted out.
        const sourceLines = source.split("\n");
        const trailingBlank =
            (sourceLines[block.end + 1] ?? "").trim().length === 0 && block.end + 1 < sourceLines.length;
        const cut = trailingBlank ? `${block.text}\n` : block.text;
        // Cut by CONTENT, not by line number. The block text was just read from the file, so it is
        // exact; if the file moved under us between locating and applying, this MISSes and the
        // batch fails instead of cutting whatever now sits at those lines.
        edits.push({
            file: move.from,
            ops: [{ find: cut, replace: "", label: `${label}: cut` }],
            absentAfter: [block.text],
        });

        const anchor = move.at ?? "end";
        const paste: Op =
            anchor === "end"
                ? { kind: "append", text: `\n${block.text}\n`, label: `${label}: paste` }
                : "after" in anchor
                  ? {
                        kind: "insertAfter",
                        anchor: anchor.after,
                        text: `\n${block.text}\n`,
                        label: `${label}: paste`,
                    }
                  : {
                        kind: "insertBefore",
                        anchor: anchor.before,
                        text: `${block.text}\n\n`,
                        label: `${label}: paste`,
                    };
        edits.push({
            file: move.to,
            ...(move.createWith === undefined ? {} : { createWith: move.createWith }),
            ops: [paste],
            expectAfter: [block.text],
        });
    }

    return edits;
}
