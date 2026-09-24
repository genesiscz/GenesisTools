/**
 * fable-replace — THE SPEC FORMAT the CLI reads. Zero escaping, heredoc-friendly,
 * readable by any model. Git-conflict-marker shaped:
 *
 *   @@ src/foo.ts                 # start a file section (path relative to cwd, or absolute)
 *   expect: newName(              # optional post-conditions for this file, repeatable
 *   absent: oldName(
 *   <<<                           # a literal replace op (exactly-once by default)
 *   exact current text, indentation included
 *   ===
 *   replacement text
 *   >>>
 *   <<< count=all                 # every occurrence
 *   <<< count=3                   # exactly three
 *   <<< optional                  # SKIP instead of MISS when absent (re-runnable)
 *   <<< label=drop legacy gate    # free text for the report (rest of the line)
 *   <<< regex flags=gi            # find is a JS regex source, replace may use $1; count=N pins matches
 *   <<< fuzzy                     # whitespace-insensitive literal
 *   <<< after                     # insert whole lines AFTER the line containing the (unique) anchor
 *   anchor text
 *   ===
 *   lines to insert
 *   >>>
 *   <<< before                    # same, before the line
 *   <<< append                    # one body only: lines appended at end of file
 *   <<< delete                    # one body only: these lines go, newline included
 *   <<< block                     # three bodies: from === to === replacement (empty = delete the block)
 *   <<< create                    # one body only: create the file with this content (must not exist)
 *
 * A body is the lines between the markers, joined with "\n", no trailing newline.
 * Everything between `<<<` and `>>>` is raw: only a line that is exactly `===` or
 * `>>>` is special there. Outside a block, blank lines and `#` comments are ignored.
 * JSON is accepted too: a top-level array of FileEdit objects (regex ops carry
 * `find` as a string plus optional `flags`).
 */

import { parseJson } from "./json";
import { expandMoves } from "./move-blocks";
import { mergeFileEdits } from "./sweep-many-files";
import type { FileEdit, Op } from "./types";

export interface ParseSpecParams {
    text: string;
    /** Receives non-fatal warnings (an unbalanced code fence that hints at a bare >>> closing a block early). */
    onWarning?: (message: string) => void;
    /** Where a `move` marker resolves its relative paths. Defaults to the process directory. */
    cwd?: string;
}

interface Section {
    file: string;
    ops: Op[];
    expectAfter: string[];
    absentAfter: string[];
    createWith?: string;
}

function fail(line: number, message: string): never {
    throw new Error(`spec line ${line}: ${message}`);
}

const KINDS = new Set(["regex", "fuzzy", "before", "after", "append", "delete", "block", "create", "move"]);
/** The kinds whose `count=` is a checked contract; the others anchor on a unique line or have nothing to count. */
const COUNTED_KINDS = new Set(["replace", "regex", "fuzzy", "delete"]);
/** Every `kind` a JSON op object may carry (a literal op has none, or "replace"). */
const OP_KINDS = new Set([
    "replace",
    "regex",
    "fuzzy",
    "deleteBlock",
    "replaceBlock",
    "insertBefore",
    "insertAfter",
    "insertLinesBefore",
    "insertLinesAfter",
    "append",
    "dropComments",
    "deleteLines",
]);

interface Modifiers {
    kind: string;
    count?: number | "all";
    optional: boolean;
    label?: string;
    flags?: string;
    /** `move` only: the file the block is pasted into. */
    to?: string;
    /** `move` only: the declaration to take, doc comment included. */
    symbol?: string;
    /** `move` only: `12-40`, when the block is not one declaration. */
    lines?: string;
    /** `move` only: `after` or `before`; the body is then the anchor. Default: append. */
    at?: string;
}

const parseModifiers = (raw: string, line: number): Modifiers => {
    const mods: Modifiers = { kind: "replace", optional: false };
    let rest = raw.trim();
    const labelAt = rest.indexOf("label=");
    if (labelAt !== -1) {
        const labelText = rest.slice(labelAt + "label=".length).trim();
        // `label=` takes the REST of the line, so a modifier written AFTER it was silently
        // absorbed: `<<< label=see ticket, regex flags=g` ran as a LITERAL search, matched
        // something unrelated once, and reported OK. Quote the label to keep such a word.
        const quoted =
            labelText.length > 1 &&
            ((labelText.startsWith('"') && labelText.endsWith('"')) ||
                (labelText.startsWith("'") && labelText.endsWith("'")));
        if (!quoted) {
            const swallowed = labelText
                .split(/\s+/)
                .find((t) => KINDS.has(t) || t === "optional" || /^(count|flags)=/.test(t));
            if (swallowed !== undefined) {
                fail(
                    line,
                    `"${swallowed}" was absorbed into the label: label= takes the whole rest of the line. Put label= LAST (<<< regex flags=g label=your text). If the word really belongs to the label, quote it: label="your text"`
                );
            }
        }

        mods.label = quoted ? labelText.slice(1, -1) : labelText;
        rest = rest.slice(0, labelAt);
    }
    for (const token of rest.split(/\s+/).filter((t) => t.length > 0)) {
        const [key, value] = token.includes("=") ? token.split("=", 2) : [token, undefined];
        if (value === undefined && KINDS.has(key)) {
            if (mods.kind !== "replace") {
                fail(line, `two op kinds on one marker: ${mods.kind} and ${key}`);
            }
            mods.kind = key;
        } else if (key === "optional" && value === undefined) {
            mods.optional = true;
        } else if (key === "count" && value !== undefined) {
            if (value === "all") {
                mods.count = "all";
            } else if (/^\d+$/.test(value) && Number(value) > 0) {
                mods.count = Number(value);
            } else {
                fail(line, `count must be a positive number or "all", got "${value}"`);
            }
        } else if (key === "flags" && value !== undefined) {
            mods.flags = value;
        } else if (key === "to" && value !== undefined) {
            mods.to = value;
        } else if (key === "symbol" && value !== undefined) {
            mods.symbol = value;
        } else if (key === "lines" && value !== undefined) {
            mods.lines = value;
        } else if (key === "at" && value !== undefined) {
            // Anything else used to fall through to `after`, so `at=start` or a typo pasted after
            // the anchor instead of failing.
            if (value !== "before" && value !== "after") {
                fail(line, `at= must be before or after, got "${value}"`);
            }

            mods.at = value;
        } else {
            fail(
                line,
                `unknown modifier "${token}". Known: ${[...KINDS].join(", ")}, count=N|all, optional, flags=…, label=…`
            );
        }
    }
    // A modifier the kind does not enforce used to be accepted and dropped, so a declared
    // constraint read as verified while nothing checked it.
    if (mods.count !== undefined && !COUNTED_KINDS.has(mods.kind)) {
        fail(
            line,
            `count= is not enforced for ${mods.kind}: before/after/block need a unique anchor, append/create have nothing to count. Remove it.`
        );
    }
    if (mods.flags !== undefined && mods.kind !== "regex") {
        fail(line, `flags= only applies to regex, not ${mods.kind}`);
    }
    for (const [key, value] of [
        ["to", mods.to],
        ["symbol", mods.symbol],
        ["lines", mods.lines],
        ["at", mods.at],
    ] as const) {
        if (value !== undefined && mods.kind !== "move") {
            fail(line, `${key}= only applies to move, not ${mods.kind}`);
        }
    }
    if (mods.kind === "move") {
        if (mods.to === undefined) {
            fail(line, "move needs to=<path>: the file the block is pasted into");
        }

        if ((mods.symbol === undefined) === (mods.lines === undefined)) {
            fail(line, "move needs exactly one of symbol=<name> or lines=<first>-<last>");
        }
    }
    if (mods.optional && (mods.kind === "append" || mods.kind === "create")) {
        fail(line, `optional has no meaning for ${mods.kind}: it cannot miss`);
    }
    return mods;
};

const partsNeeded = (kind: string): number => {
    switch (kind) {
        case "append":
        case "delete":
        case "create":
        case "move":
            return 1;
        case "block":
            return 3;
        default:
            return 2;
    }
};

const compileRegex = ({ source, flags, line }: { source: string; flags: string; line: number }): RegExp => {
    try {
        return new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
    } catch (err) {
        return fail(line, `invalid regex or flags: ${err instanceof Error ? err.message : String(err)}`);
    }
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: the parser refuses control characters in a spec on purpose
const CONTROL_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

const buildOp = (
    mods: Modifiers,
    parts: string[],
    line: number,
    section: Section,
    moved: FileEdit[],
    cwd: string
): void => {
    const need = partsNeeded(mods.kind);
    if (parts.length !== need) {
        fail(line, `${mods.kind} needs ${need} bod${need === 1 ? "y" : "ies"} (separated by ===), got ${parts.length}`);
    }
    for (const [k, part] of parts.entries()) {
        const bad = part.match(CONTROL_CHAR);
        if (bad !== null) {
            const code = `0x${bad[0].charCodeAt(0).toString(16).padStart(2, "0")}`;
            fail(
                line,
                `body ${k + 1} contains a control character (${code}). That is a shell escaping artifact: zsh's echo turns \\b into a backspace. Build spec text with printf '%s\\n', never echo.`
            );
        }
    }
    const [a, b, c] = parts;
    const emptyFirst = mods.kind === "fuzzy" ? a.trim() === "" : a === "";
    if (emptyFirst && mods.kind !== "create" && mods.kind !== "append" && mods.kind !== "move") {
        // An empty needle or anchor matches everywhere or nowhere; the runner refuses it
        // too, but a spec error names the line before anything is planned.
        fail(line, `${mods.kind}: the first body is empty, so there is nothing to find, delete or anchor on`);
    }

    const common = { optional: mods.optional, label: mods.label };
    if (mods.kind === "move") {
        // A move spans two files, so it cannot be an op on this section. It resolves here, against
        // the file on disk, and contributes the cut and the paste as ordinary edits that the
        // runner merges with everything else.
        // The body is the anchor for at=, and nothing else. Without this pairing an at= with no
        // body appended silently, and a body with no at= was dropped silently.
        if (mods.at !== undefined && a.trim() === "") {
            fail(line, `at=${mods.at} needs the anchor text as the body`);
        }

        if (mods.at === undefined && a.trim() !== "") {
            fail(line, "a move body is only read as the anchor for at=before|after; add at= or leave the body empty");
        }

        const at =
            mods.at === undefined
                ? undefined
                : mods.at === "before"
                  ? ({ before: a } as const)
                  : ({ after: a } as const);
        const span = mods.lines?.split("-").map((part) => Number(part.trim()));
        if (span && (span.length !== 2 || span.some((n) => !Number.isInteger(n) || n < 1))) {
            fail(line, `lines= must be <first>-<last>, both positive integers, got "${mods.lines}"`);
        }

        try {
            moved.push(
                ...expandMoves(
                    [
                        {
                            from: section.file,
                            to: mods.to as string,
                            ...(mods.symbol === undefined ? {} : { symbol: mods.symbol }),
                            ...(span ? { lines: [span[0], span[1]] as [number, number] } : {}),
                            ...(at === undefined ? {} : { at }),
                            ...(mods.label === undefined ? {} : { label: mods.label }),
                        },
                    ],
                    { cwd }
                )
            );
        } catch (error) {
            fail(line, error instanceof Error ? error.message : String(error));
        }

        return;
    }

    switch (mods.kind) {
        case "replace":
            section.ops.push({ find: a, replace: b, count: mods.count, ...common });
            return;
        case "regex": {
            section.ops.push({
                kind: "regex",
                find: compileRegex({ source: a, flags: mods.flags ?? "g", line }),
                replace: b,
                expect: typeof mods.count === "number" ? mods.count : undefined,
                ...common,
            });
            return;
        }
        case "fuzzy":
            section.ops.push({ kind: "fuzzy", find: a, replace: b, count: mods.count, ...common });
            return;
        case "before":
        case "after":
            section.ops.push({
                kind: mods.kind === "before" ? "insertLinesBefore" : "insertLinesAfter",
                anchor: a,
                text: b,
                ...common,
            });
            return;
        case "append":
            section.ops.push({ kind: "append", text: a, label: mods.label });
            return;
        case "delete":
            section.ops.push({
                find: `${a}\n`,
                replace: "",
                count: mods.count,
                wholeLines: true,
                ...common,
                label: mods.label ?? `delete "${a.split("\n")[0].trim().slice(0, 44)}"`,
            });
            return;
        case "block":
            section.ops.push(
                c.length === 0
                    ? { kind: "deleteBlock", from: a, to: b, ...common }
                    : { kind: "replaceBlock", from: a, to: b, replace: c, ...common }
            );
            return;
        case "create":
            if (section.createWith !== undefined) {
                fail(line, "create given twice for one file");
            }
            section.createWith = a.endsWith("\n") ? a : `${a}\n`;
            return;
        default:
            fail(line, `unhandled kind ${mods.kind}`);
    }
};

const toFileEdit = (section: Section): FileEdit => {
    const edit: FileEdit = { file: section.file };
    if (section.ops.length > 0) {
        edit.ops = section.ops;
    }
    if (section.createWith !== undefined) {
        edit.createWith = section.createWith;
    }
    if (section.expectAfter.length > 0) {
        edit.expectAfter = section.expectAfter;
    }
    if (section.absentAfter.length > 0) {
        edit.absentAfter = section.absentAfter;
    }
    return edit;
};

const fromJson = (text: string): FileEdit[] => {
    const raw = parseJson(text);
    if (!Array.isArray(raw)) {
        throw new Error("JSON spec must be an array of FileEdit objects");
    }
    return raw.map((edit) => {
        if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
            throw new Error("every JSON spec entry must be a FileEdit object");
        }

        // TypeScript casts do not check external input. "delete": "false" is a truthy
        // string, and the runner used to delete the file on it.
        const fields = edit as Record<string, unknown>;
        const typeErrors: string[] = [];
        if (typeof fields.file !== "string" || fields.file === "") {
            typeErrors.push("file must be a non-empty string");
        }
        for (const name of ["delete", "overwrite", "allowGenerated"]) {
            if (fields[name] !== undefined && typeof fields[name] !== "boolean") {
                typeErrors.push(`${name} must be true or false, got ${String(fields[name])} (${typeof fields[name]})`);
            }
        }
        for (const name of ["renameTo", "createWith"]) {
            if (fields[name] !== undefined && typeof fields[name] !== "string") {
                typeErrors.push(`${name} must be a string`);
            }
        }
        if (fields.ops !== undefined && !Array.isArray(fields.ops)) {
            typeErrors.push("ops must be an array");
        }
        if (typeErrors.length > 0) {
            throw new Error(`${String(fields.file ?? "?")}: ${typeErrors.join("; ")}`);
        }

        const e = edit as FileEdit;
        const rawOps = ((edit as { ops?: unknown }).ops ?? []) as Array<Record<string, unknown>>;
        const ops = rawOps.map((op, index) => {
            // A misspelled kind used to fall through to the literal branch and edit an exact
            // occurrence, reporting OK for an op nobody wrote.
            if (op.kind !== undefined && !OP_KINDS.has(String(op.kind))) {
                throw new Error(
                    `${String(e.file)}: op ${index + 1} has unknown kind "${String(op.kind)}". Known: ${[...OP_KINDS].join(", ")}`
                );
            }

            return op.kind === "regex" && typeof op.find === "string"
                ? ({ ...op, find: new RegExp(op.find, typeof op.flags === "string" ? op.flags : "g") } as unknown as Op)
                : (op as unknown as Op);
        });
        return { ...e, ops };
    });
};

/** Parse the marker format (or a JSON array) into FileEdits for `run()`. Throws with a line number on any malformed input. */
export const parseSpec = ({ text, onWarning, cwd }: ParseSpecParams): FileEdit[] => {
    const moved: FileEdit[] = [];
    const trimmed = text.trimStart();
    if (trimmed.startsWith("[")) {
        try {
            return fromJson(trimmed);
        } catch (err) {
            // A marker spec whose first line happens to start with "[" (a changelog entry,
            // a markdown link) used to surface a bare JSON error naming no spec line.
            fail(
                1,
                `the spec starts with "[", so it was read as the JSON form: ${String(err)}. A marker spec must start with an "@@ <path>" header.`
            );
        }
    }
    // A spec pasted from two sources can carry CRLF on some lines only. Splitting on "\n"
    // alone left a "\r" on the markers, so "===" and ">>>" stopped being recognised and the
    // next op was swallowed into the previous body — one op silently became none.
    const lines = text.split(/\r\n|\n/);
    const sections: Section[] = [];
    let current: Section | null = null;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const lineNo = i + 1;
        if (line.startsWith("@@")) {
            const file = line.slice(2).trim();
            if (file.length === 0) {
                fail(lineNo, "@@ needs a file path");
            }
            if (/^[-+]\d/.test(file)) {
                fail(
                    lineNo,
                    `"${line.slice(0, 40)}" looks like a diff hunk header, not a file path. A body line that was exactly >>> closed the previous block early; write such a line as \\>>>`
                );
            }
            current = { file, ops: [], expectAfter: [], absentAfter: [] };
            sections.push(current);
            i += 1;
            continue;
        }
        if (line.startsWith("<<<")) {
            if (current === null) {
                fail(lineNo, "op before any @@ file line");
            }
            const mods = parseModifiers(line.slice(3), lineNo);
            const parts: string[] = [];
            const separatorLines: number[] = [];
            let body: string[] = [];
            let closed = false;
            i += 1;
            while (i < lines.length) {
                const inner = lines[i];
                if (inner === "===") {
                    parts.push(body.join("\n"));
                    body = [];
                    separatorLines.push(i + 1);
                } else if (inner === ">>>") {
                    parts.push(body.join("\n"));
                    closed = true;
                    i += 1;
                    break;
                } else if (inner === "\\===" || inner === "\\>>>") {
                    // A body line that must be exactly === or >>> carries one leading backslash.
                    body.push(inner.slice(1));
                } else {
                    body.push(inner);
                }
                i += 1;
            }
            if (!closed) {
                // Three of the day's spec errors on 2026-09-07 were this line on a whole-file create
                // body of 5k to 23k chars: the heredoc had ended early on a body line equal to its
                // delimiter, so the parser saw a body with no end. Name the cut point and the trap.
                const read = body.length > 0 && body[body.length - 1] === "" ? body.slice(0, -1) : body;
                const tail = read.slice(-3).map((l) => `"${l.length > 60 ? `${l.slice(0, 60)}…` : l}"`);
                fail(
                    lineNo,
                    `block (${mods.kind}) never closed with >>>: the spec ended ${read.length} line(s) into its body, last line(s) read: ${tail.join(", ")}. Either the closing >>> is missing, or your heredoc ended early because a body line equals its delimiter (a line that is exactly EOF, say). Pick a delimiter that cannot appear in the bodies, or write the spec to a file and pass --spec <file>.`
                );
            }
            const need = partsNeeded(mods.kind);
            if (parts.length > need) {
                fail(
                    separatorLines[need - 1] ?? lineNo,
                    `${mods.kind} takes ${need} bod${need === 1 ? "y" : "ies"}, but this line is exactly === and starts body ${need + 1}. A body line that must be exactly === is written \\===`
                );
            }
            // A bare >>> inside a NON-final body already fails ("takes N bodies"), so only the
            // LAST body can be truncated silently. Only that body is inspected, and only a fence
            // left OPEN with content after it counts: the anchors of a `block` op are fragments
            // and may legitimately end on a closing fence alone, and a body that IS a fence line
            // (replacing ```sh with ```bash) is complete.
            const lastLines = (parts[parts.length - 1] ?? "").split("\n");
            const fenceLines = lastLines.map((l, idx) => (l.startsWith("```") ? idx : -1)).filter((idx) => idx !== -1);
            const openedAt = fenceLines.length % 2 === 1 ? fenceLines[fenceLines.length - 1] : -1;
            if (openedAt !== -1 && openedAt < lastLines.length - 1) {
                onWarning?.(
                    `spec line ${lineNo}: the last body of this block ends inside a code fence opened at its line ${openedAt + 1}. If a body line was exactly >>> it closed the block early and the rest was dropped; write such a line as \\>>>`
                );
            }
            buildOp(mods, parts, lineNo, current, moved, cwd ?? process.cwd());
            continue;
        }
        const cond = line.match(/^(expect|absent):\s?(.*)$/);
        if (cond !== null) {
            if (current === null) {
                fail(lineNo, `${cond[1]}: before any @@ file line`);
            }
            (cond[1] === "expect" ? current.expectAfter : current.absentAfter).push(cond[2]);
            i += 1;
            continue;
        }
        if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
            i += 1;
            continue;
        }
        fail(
            lineNo,
            `unexpected text outside a block: "${line.slice(0, 60)}". Lines outside <<< >>> must be @@ file, expect:, absent:, # comment, or blank. If this line belongs to the previous block, a body line was exactly >>> or === and closed it early: write such lines as \\>>> or \\===`
        );
    }
    if (sections.length === 0) {
        throw new Error("spec has no @@ file sections");
    }
    // A move contributes edits to a file the spec may never name with @@, and to one it does, so
    // the two lists are merged rather than concatenated.
    const edits = sections.map(toFileEdit);
    return moved.length === 0 ? edits : mergeFileEdits([...moved, ...edits]);
};
