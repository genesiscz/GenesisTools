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
import { planImportFixes } from "./move-imports";
import { phpPreamble } from "./move-imports-php";
import { MoveError, type PlannedMove } from "./move-imports-shared";
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
    /**
     * `widen`, with `imports: "fix"`: a declaration that must cross the new file boundary is
     * exported (TS) or loses `private`/`fileprivate`, or gains `public` across modules (Swift).
     */
    visibility?: "widen";
}

export interface ExpandMovesOptions {
    cwd?: string;
    /** Content a file will have before any op runs, by absolute path: a `create` in the same batch. */
    files?: Map<string, string>;
    onWarning?: (message: string) => void;
    /** Overrides the files scanned for importers (tests); defaults to git's view of the repository. */
    projectFiles?: string[];
    /** True when an op elsewhere in the same spec already rewrites `needle` in `abs`. */
    isHandled?: (abs: string, needle: string) => boolean;
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

/** A line that opens an attribute or decorator: PHP `#[...]`, Swift `@MainActor`, TS `@Component(...)`. */
const ATTRIBUTE_LINE = /^(?:#\[|@[A-Za-z_])/;

/**
 * The first attribute or decorator line directly above `line`, or `line` itself. They belong to the
 * declaration: a cut that left `#[Attr]` behind broke the source file and stripped the class.
 * An attribute over several lines counts from its opening line down to its closing `)` or `]`.
 */
function attributesStart(lines: string[], line: number): number {
    let first = line;
    while (first > 0) {
        const previous = lines[first - 1].trim();
        if (ATTRIBUTE_LINE.test(previous)) {
            first--;
            continue;
        }

        if (!/[)\]]$/.test(previous)) {
            break;
        }

        let opening = first - 2;
        while (opening >= 0 && first - opening <= 30) {
            const candidate = lines[opening].trim();
            if (candidate === "" || /[;{}]$/.test(candidate)) {
                opening = -1;
                break;
            }

            if (ATTRIBUTE_LINE.test(candidate)) {
                break;
            }

            opening--;
        }

        if (opening < 0 || first - opening > 30) {
            break;
        }

        first = opening;
    }

    return first;
}

/** The first line of the doc comment (and attributes) attached directly above `line`, or `line` itself. */
export function docCommentStart(lines: string[], declared: number): number {
    const line = attributesStart(lines, declared);
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

/**
 * The text a cut removes: the block with its own line terminator, plus one blank line after it
 * (or, for the file's last block, the blank line above it), so repeated cuts leave no gaps.
 */
export function cutFor(source: string, block: LocatedBlock, taken?: Set<number>): string {
    const sourceLines = source.split("\n");
    const next = sourceLines[block.end + 1];
    // `block.end + 2 < length` excludes the "" that follows a file's final newline. A blank line
    // another cut of the same batch already takes stays with that cut (`taken`, which this adds to).
    const trailingBlank =
        next !== undefined &&
        next.trim().length === 0 &&
        block.end + 2 < sourceLines.length &&
        !taken?.has(block.end + 1);
    // The file's last block has no blank line after it to take, so it takes the one above it;
    // otherwise every split that moves the tail leaves the source ending on an empty line.
    const previous = sourceLines[block.start - 1];
    const endsFile = next === undefined || (next === "" && block.end + 2 === sourceLines.length);
    const takesPrevious =
        !trailingBlank &&
        endsFile &&
        previous !== undefined &&
        previous.trim().length === 0 &&
        !taken?.has(block.start - 1);
    if (taken !== undefined) {
        for (let line = takesPrevious ? block.start - 1 : block.start; line <= block.end; line++) {
            taken.add(line);
        }

        if (trailingBlank) {
            taken.add(block.end + 1);
        }
    }

    const leading = takesPrevious ? `${previous}\n` : "";
    return leading + (next === undefined ? block.text : trailingBlank ? `${block.text}\n${next}\n` : `${block.text}\n`);
}

/** Where a declaration sits: its doc comment's first line, its first attribute line, its own line, its last line (0-indexed). */
export function declarationSpan(
    source: string,
    symbol: string,
    file: string
): { docStart: number; attrStart: number; declared: number; end: number } {
    const lines = source.split("\n");
    const pattern = DECLARATION(symbol);
    const matches = lines.map((line, index) => (pattern.test(line) ? index : -1)).filter((index) => index !== -1);
    if (matches.length === 0) {
        throw new Error(`no declaration of ${symbol} in ${file}`);
    }

    if (matches.length > 1) {
        throw new Error(
            `${symbol} is declared more than once in ${file} (lines ${matches.map((i) => i + 1).join(", ")})`
        );
    }

    const declared = matches[0];
    const end = blockEndLine(lines, declared);
    if (end === -1) {
        throw new Error(`${symbol} in ${file} is never closed; the file may be malformed`);
    }

    return { docStart: docCommentStart(lines, declared), attrStart: attributesStart(lines, declared), declared, end };
}

/**
 * The anchor an `at=before` paste uses: when the anchor line carries a doc comment, the comment
 * and the line together, so the block lands above the comment instead of between the comment and
 * the line it documents.
 */
function beforeAnchor(target: string | undefined, anchor: string): string {
    if (target === undefined) {
        return anchor;
    }

    const lines = target.split("\n");
    const firstLine = anchor.split("\n")[0];
    const hits = lines.map((line, index) => (line.includes(firstLine) ? index : -1)).filter((index) => index !== -1);
    if (hits.length !== 1 || hits[0] === 0) {
        return anchor;
    }

    const index = hits[0];
    const start = docCommentStart(lines, index);
    if (start === index) {
        return anchor;
    }

    const prefix = lines[index].slice(0, lines[index].indexOf(firstLine));
    return [...lines.slice(start, index), `${prefix}${anchor}`].join("\n");
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

    try {
        const { docStart, end } = declarationSpan(source, spec.symbol, spec.from);
        return slice(docStart, end);
    } catch (error) {
        throw new Error(`move: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    // A created target's content before any op: the planner reads it, so a new PHP file is seen
    // with its `<?php` and namespace lines and its `use` lines go under them.
    const created = new Map<string, string>();
    const cutLines = new Map<string, Set<number>>();
    for (const [index, move] of moves.entries()) {
        try {
            planned.push(expandOne({ move, index, cwd, readAbs, created, cutLines, edits }));
        } catch (error) {
            throw error instanceof MoveError
                ? error
                : new MoveError(error instanceof Error ? error.message : String(error), index);
        }
    }

    const importEdits = planImportFixes({
        moves: planned,
        cwd,
        read: (abs) => created.get(abs) ?? readAbs(abs),
        ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
        ...(options.projectFiles === undefined ? {} : { projectFiles: options.projectFiles }),
        ...(options.isHandled === undefined ? {} : { isHandled: options.isHandled }),
    });
    // A widened move rewrites its pasted block in one op; the paste's post-condition then names
    // the rewritten text, or it would fail on the very change the batch asked for.
    for (const importEdit of importEdits) {
        for (const op of importEdit.ops ?? []) {
            if (
                !("find" in op) ||
                typeof op.find !== "string" ||
                !("replace" in op) ||
                typeof op.replace !== "string"
            ) {
                continue;
            }

            const rewritten = op.replace;
            for (const move of planned) {
                if (move.blockText !== op.find || path.resolve(cwd, importEdit.file) !== move.toAbs) {
                    continue;
                }

                const before = landmark(move.blockText);
                for (const edit of edits) {
                    if (path.resolve(cwd, edit.file) === move.toAbs && edit.expectAfter !== undefined) {
                        edit.expectAfter = edit.expectAfter.map((text) =>
                            text === before ? landmark(rewritten) : text
                        );
                    }
                }
            }
        }
    }

    edits.push(...importEdits);
    return edits;
}

/**
 * What a paste's post-condition looks for: the block's first code line, not the whole block. A
 * later op in the same batch may edit inside the pasted block (add an init, export it), and
 * the whole-block check failed exactly those batches; the first code line still proves the
 * block landed.
 */
function landmark(blockText: string): string {
    const lines = blockText.split("\n");
    return (
        lines.find((line) => {
            const trimmed = line.trim();
            return trimmed !== "" && !/^(?:\/\/|\/\*|\*|#)/.test(trimmed);
        }) ??
        lines[0] ??
        blockText
    );
}

interface ExpandOneParams {
    move: MoveSpec;
    index: number;
    cwd: string;
    readAbs: (abs: string) => string | undefined;
    /** Targets an earlier move in this batch creates. */
    created: Map<string, string>;
    /** Per source, the lines (blank separators included) the batch's earlier cuts take. */
    cutLines: Map<string, Set<number>>;
    edits: FileEdit[];
}

function expandOne({ move, index, cwd, readAbs, created, cutLines, edits }: ExpandOneParams): PlannedMove {
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
    const taken = cutLines.get(fromAbs) ?? new Set<number>();
    cutLines.set(fromAbs, taken);
    const cut = cutFor(source, block, taken);
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

    // A new PHP file is code only after `<?php`, its namespace and the source's strict types.
    const createWith =
        move.createWith ?? (targetIsNew && toAbs.endsWith(".php") ? phpPreamble(toAbs, source) : undefined);
    const startsFile = targetIsNew && (createWith ?? "") === "";
    if (targetIsNew) {
        created.set(toAbs, createWith ?? "");
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
                    anchor: beforeAnchor(readAbs(toAbs), anchor.before),
                    text: `${block.text}\n\n`,
                    label: `${label}: paste`,
                };
    edits.push({
        file: move.to,
        ...(targetIsNew ? { createWith: createWith ?? "" } : {}),
        ops: [paste],
        expectAfter: [landmark(block.text)],
    });

    return {
        index,
        from: move.from,
        to: move.to,
        fromAbs,
        toAbs,
        blockText: block.text,
        startLine: block.start + 1,
        endLine: block.end + 1,
        cutText: cut,
        fixImports: move.imports === "fix",
        widen: move.visibility === "widen",
        marker: markerFor(move),
        label,
    };
}

/** The move as the spec marker that would produce it. */
function markerFor(move: MoveSpec): string {
    const what =
        move.symbol !== undefined
            ? `symbol=${move.symbol}`
            : move.lines !== undefined
              ? `lines=${move.lines[0]}-${move.lines[1]}`
              : "";
    const at = move.at === undefined || move.at === "end" ? "" : "after" in move.at ? " at=after" : " at=before";
    const imports = move.imports === "fix" ? " imports=fix" : "";
    return `<<< move to=${move.to} ${what}${at}${imports}${move.visibility === "widen" ? " visibility=widen" : ""}`;
}
