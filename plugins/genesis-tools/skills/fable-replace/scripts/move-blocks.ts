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
import { MoveError, type PlannedMove, planImportFixes } from "./move-imports";
import type { FileEdit, Op } from "./types";

/**
 * Where the moved block lands in the target file. There is no "start": the top of a file is its
 * imports, so a block pasted there is wrong more often than right. Anchor on the first line instead.
 */
export type MoveAnchor = "end" | { after: string } | { before: string };

export interface MoveSpec {
    /** File the block is cut from. */
    from: string;
    /** File the block is pasted into. Must differ from `from`; a move within one file is an ordinary op. */
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
    /**
     * `fix`: the target gains the imports the block uses, the source drops the ones only the block
     * used, and every importer of a moved export is re-pointed (mixed imports split).
     */
    imports?: "fix";
}

export interface ExpandMovesOptions {
    cwd?: string;
    /** Content a file will have before any op runs, by absolute path: a `create` in the same batch. */
    files?: Map<string, string>;
    onWarning?: (message: string) => void;
    /** Overrides the files scanned for importers (tests); defaults to git's view of the repository. */
    projectFiles?: string[];
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
        // Any run of modifiers, in any order: `export abstract class`, `export declare const`
        // and Swift's `public final class` were all refused as "no declaration" before.
        "^\\s*(?:(?:export|default|declare|abstract|public|private|protected|internal|fileprivate|open|final|override|async|static|readonly)\\s+)*" +
            `(?:function|class|interface|type|enum|struct|extension|protocol|const|let|var|func)\\s+` +
            `${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
    );

/**
 * A `/` right after one of these, or at the start of a line, opens a regex literal, not a division.
 * No `<`: in TSX the `/` of a closing tag `</li>` follows it, and reading that as a regex skipped
 * the `)}` that closed the JSX expression.
 */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%>~^";
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|yield|await|throw|in|of|delete|void|new)$/;

/**
 * The index of the `/` that closes a regex literal opening at `at`, or -1 when that `/` is a
 * division. Decided by what precedes it, the way a tokenizer does without a full parse.
 */
function regexLiteralEnd(line: string, at: number): number {
    const before = line.slice(0, at).trimEnd();
    const last = before.at(-1);

    // `/>` closes a self-closing JSX element (`<Row onClick={f} />`), and the `}` before it is a
    // preceder, so without this it opened a "regex" too. Only after `}`: a real regex that starts
    // with `>` follows `(` or `=` (`.replace(/>/g, …)`) and must still be skipped as one.
    if (line[at + 1] === ">" && last === "}") {
        return -1;
    }
    if (last !== undefined && !REGEX_PRECEDERS.includes(last) && !REGEX_KEYWORDS.test(before)) {
        return -1;
    }

    let inClass = false;
    for (let i = at + 1; i < line.length; i++) {
        const char = line[i];
        if (char === "\\") {
            i++;
        } else if (char === "[") {
            inClass = true;
        } else if (char === "]") {
            inClass = false;
        } else if (char === "/" && !inClass) {
            return i;
        }
    }

    // No closing slash on this line: it was a division after all.
    return -1;
}

/**
 * The line where the block that starts at `from` closes.
 *
 * Counts brackets while skipping the places a bracket is not code: line comments, block comments,
 * single and double quoted strings, and template literals. A naive depth count reads the `{` in
 * `"a { b"` as an opening brace and then takes the rest of the file with it, which is exactly the
 * failure that makes an automated move untrustworthy.
 */
export function blockEndLine(lines: string[], from: number): number {
    let depth = 0;
    let opened = false;
    let inBlockComment = false;
    let inTemplate = false;
    // A Swift `"""` string spans lines, and a `}` on one of its content lines is text. Reading
    // it as code closed the declaration early, and the move cut a valid file at the wrong line.
    let inMultilineString = false;
    for (let index = from; index < lines.length; index++) {
        const line = lines[index];
        let quote: string | null = null;
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

            if (inMultilineString) {
                if (char === "\\") {
                    i++;
                } else if (line.startsWith('"""', i)) {
                    inMultilineString = false;
                    i += 2;
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

            if (line.startsWith('"""', i)) {
                inMultilineString = true;
                i += 2;
                continue;
            }

            if (char === '"' || char === "'") {
                quote = char;
                continue;
            }

            if (char === "`") {
                inTemplate = true;
                continue;
            }

            if (char === "/") {
                // `const re = /}/;` would otherwise close the block on the brace inside the literal.
                const close = regexLiteralEnd(line, i);
                if (close !== -1) {
                    i = close;
                }

                continue;
            }

            // Parentheses and brackets nest too, but only a brace OPENS a block. Otherwise the
            // `{ title }` of `function Card({ title }: Props) {` closed the block on the
            // declaration line, and so did `opts = {}` and `x: { a: number }`.
            if (char === "(" || char === "[") {
                depth++;
                continue;
            }

            if (char === ")" || char === "]") {
                depth--;
                continue;
            }

            if (char === "{") {
                depth++;
                opened = true;
                continue;
            }

            if (char === "}") {
                depth--;
                if (opened && depth <= 0) {
                    return index;
                }
            }
        }

        // A statement ends on a `;` at depth 0: `type Id = string;`, and the `});` that closes
        // `const x = foo(() => { … });` once its parentheses have balanced.
        if (
            depth <= 0 &&
            !inBlockComment &&
            !inTemplate &&
            !inMultilineString &&
            quote === null &&
            line.trimEnd().endsWith(";")
        ) {
            return index;
        }
    }

    return -1;
}

/** The first line of the doc comment attached directly above `line`, or `line` itself. */
export function docCommentStart(lines: string[], line: number): number {
    let index = line - 1;
    while (index >= 0 && lines[index].trim().length === 0) {
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

/**
 * Turn moves into the file edits the sweep engine already knows how to run atomically. A failure
 * that belongs to one move is a `MoveError` carrying that move's position in `moves`.
 */
export function expandMoves(moves: MoveSpec[], options: ExpandMovesOptions = {}): FileEdit[] {
    const cwd = options.cwd ?? process.cwd();
    const readAbs = (abs: string): string | undefined => {
        const planned = options.files?.get(abs);
        if (planned !== undefined) {
            return planned;
        }

        try {
            return fs.readFileSync(abs, "utf8");
        } catch {
            return undefined;
        }
    };
    const edits: FileEdit[] = [];
    const planned: PlannedMove[] = [];
    const created = new Set<string>();
    for (const [index, move] of moves.entries()) {
        try {
            planned.push(expandOne({ move, index, cwd, readAbs, created, edits }));
        } catch (error) {
            throw error instanceof MoveError
                ? error
                : new MoveError(error instanceof Error ? error.message : String(error), index);
        }
    }

    edits.push(
        ...planImportFixes({
            moves: planned,
            cwd,
            read: readAbs,
            ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
            ...(options.projectFiles === undefined ? {} : { projectFiles: options.projectFiles }),
        })
    );
    return edits;
}

interface ExpandOneParams {
    move: MoveSpec;
    index: number;
    cwd: string;
    readAbs: (abs: string) => string | undefined;
    /** Targets an earlier move in this batch creates. */
    created: Set<string>;
    edits: FileEdit[];
}

function expandOne({ move, index, cwd, readAbs, created, edits }: ExpandOneParams): PlannedMove {
    const fromAbs = path.resolve(cwd, move.from);
    const toAbs = path.resolve(cwd, move.to);
    if (fromAbs === toAbs) {
        throw new Error("move: `from` and `to` are the same file; use an ordinary op instead");
    }

    const source = readAbs(fromAbs);
    if (source === undefined) {
        throw new Error(`move: ${move.from} does not exist`);
    }

    const block = locateBlock(source, move);
    const label = move.label ?? `move ${move.symbol ?? `${block.start + 1}..${block.end + 1}`}`;
    // Take one blank line with the block when it is followed by one, so a move does not leave a
    // widening gap behind every time something is lifted out.
    // The cut always takes the block's own line terminator, or an empty line stays where it was.
    const sourceLines = source.split("\n");
    const next = sourceLines[block.end + 1];
    // `block.end + 2 < length` excludes the "" that follows a file's final newline.
    const trailingBlank = next !== undefined && next.trim().length === 0 && block.end + 2 < sourceLines.length;
    // The file's last block has no blank line after it to take, so it takes the one above it;
    // otherwise every split that moves the tail leaves the source ending on an empty line.
    const previous = sourceLines[block.start - 1];
    const endsFile = next === undefined || (next === "" && block.end + 2 === sourceLines.length);
    const leading =
        !trailingBlank && endsFile && previous !== undefined && previous.trim().length === 0 ? `${previous}\n` : "";
    const cut =
        leading + (next === undefined ? block.text : trailingBlank ? `${block.text}\n${next}\n` : `${block.text}\n`);
    // Cut by CONTENT, not by line number. The block text was just read from the file, so it is
    // exact; if the file moved under us between locating and applying, this MISSes and the
    // batch fails instead of cutting whatever now sits at those lines.
    edits.push({
        file: move.from,
        ops: [{ find: cut, replace: "", label: `${label}: cut` }],
        absentAfter: [block.text],
    });

    const anchor = move.at ?? "end";
    // A target that does not exist yet is created by its first move, so a split into a new
    // file is one batch. Its first block starts the file instead of following a blank line.
    const targetIsNew = !created.has(toAbs) && readAbs(toAbs) === undefined;
    if (targetIsNew && anchor !== "end") {
        throw new Error(`move: ${move.to} does not exist yet, so it has no anchor for at=; drop at= to create it`);
    }

    const startsFile = targetIsNew && (move.createWith ?? "") === "";
    if (targetIsNew) {
        created.add(toAbs);
    }

    const paste: Op =
        anchor === "end"
            ? { kind: "append", text: startsFile ? `${block.text}\n` : `\n${block.text}\n`, label: `${label}: paste` }
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
        ...(targetIsNew ? { createWith: move.createWith ?? "" } : {}),
        ops: [paste],
        expectAfter: [block.text],
    });

    return {
        index,
        from: move.from,
        to: move.to,
        fromAbs,
        toAbs,
        blockText: block.text,
        cutText: cut,
        fixImports: move.imports === "fix",
        label,
    };
}
