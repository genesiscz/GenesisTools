// `2>/dev/null` rules: discarding stderr and then reading the (possibly empty)
// stdout makes "the command failed" and "there is no data" the same output.

import {
    commandTokenIndex,
    commandWord,
    originalSlice,
    type ShellScan,
    type Span,
    simpleCommandWord,
    splitPipeline,
    splitStatements,
    splitSubstitutions,
    stripShellNoise,
    tokenize,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

const STDERR_TO_DEVNULL = /(^|\s)2>\s*\/dev\/null(?=\s|$)/g;

// mdfind writes the same two locale lines to stderr on every run, and its errors
// (a bad query, an unknown flag) to stdout, so discarding its stderr never turns
// a failure into an empty result.
const QUIET_STDERR_PRODUCERS = new Set(["mdfind"]);

// Elements that READ the piped output for the model: an empty result here is
// what gets interpreted as "there is nothing".
const READERS = new Set([
    "head",
    "tail",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "jq",
    "awk",
    "sed",
    "cut",
    "tr",
    "sort",
    "uniq",
    "xargs",
    "column",
    "tee",
    "cat",
    "less",
    "yq",
]);

function isCounter(element: string): boolean {
    const word = simpleCommandWord(element);

    if (word === "wc") {
        return true;
    }

    if (word !== "grep" && word !== "egrep" && word !== "fgrep" && word !== "rg") {
        return false;
    }

    return tokenize({ text: element, start: 0 }).some(
        (t) => t.text === "--count" || t.text === "--count-matches" || /^-[A-Za-z]*c[A-Za-z]*$/.test(t.text)
    );
}

// An element that reads the piped output for the model. `xargs` is a wrapper
// for commandTokenIndex (it runs the command after it), but as a consumer it
// reads stdin like head does: an empty input runs nothing, silently.
function isReader(element: string): boolean {
    const tokens = tokenize({ text: element, start: 0 });
    const cmd = commandTokenIndex(tokens);

    if (cmd === -1) {
        return false;
    }

    if (tokens.slice(0, cmd).some((t) => commandWord(t.text) === "xargs")) {
        return true;
    }

    return READERS.has(commandWord(tokens[cmd].text));
}

// head or tail with a zero count passes nothing on (BSD head rejects the count,
// tail prints nothing), so neither it nor any element after it reads the producer.
function passesNothing(element: string): boolean {
    const tokens = tokenize({ text: element, start: 0 });
    const cmd = commandTokenIndex(tokens);
    const word = cmd === -1 ? "" : commandWord(tokens[cmd].text);

    if (word !== "head" && word !== "tail") {
        return false;
    }

    const args = tokens.slice(cmd + 1).map((t) => t.text);
    return args.some(
        (arg, i) =>
            /^(?:-|-[nc]|--lines=|--bytes=)0+$/.test(arg) ||
            (/^(?:-[nc]|--lines|--bytes)$/.test(arg) && /^0+$/.test(args[i + 1] ?? ""))
    );
}

interface DevnullHit {
    statement: Span;
    /** The pipeline element that discards stderr. */
    producer: Span;
    /** The `2>/dev/null` token, positioned in the original command. */
    redirect: Span;
}

// Every `2>/dev/null` on a pipeline element whose later elements satisfy
// `consumes`, across all units, statements and elements, lowest offset first. A
// `$(…)` inside `bash -c "…"` is reached through the outer unit and through the
// body, so a token found twice is kept once.
function devnullHits(scan: ShellScan, consumes: (later: string[]) => boolean): DevnullHit[] {
    const hits = new Map<number, DevnullHit>();

    for (const statements of scan.units) {
        for (const statement of statements) {
            if (!statement.text.includes("/dev/null")) {
                continue;
            }

            const elements = splitPipeline(statement);

            for (let k = 0; k + 1 < elements.length; k++) {
                const producer = elements[k];
                const redirects = [...producer.text.matchAll(STDERR_TO_DEVNULL)];

                if (redirects.length === 0 || QUIET_STDERR_PRODUCERS.has(simpleCommandWord(producer.text))) {
                    continue;
                }

                const later = elements.slice(k + 1).map((e) => e.text);
                const cut = later.findIndex(passesNothing);

                if (!consumes(cut === -1 ? later : later.slice(0, cut))) {
                    continue;
                }

                for (const m of redirects) {
                    const lead = m[1].length;
                    const start = producer.start + m.index + lead;

                    if (!hits.has(start)) {
                        hits.set(start, { statement, producer, redirect: { text: m[0].slice(lead), start } });
                    }
                }
            }
        }
    }

    return [...hits.values()].sort(
        (a, b) => a.statement.start - b.statement.start || a.redirect.start - b.redirect.start
    );
}

function matchFromHits(scan: ShellScan, hits: readonly DevnullHit[]): ShellMatch {
    const { statement } = hits[0];
    const matched = originalSlice(scan, statement.start, statement.start + statement.text.length);
    let suggestion = scan.command;

    // Drop each redirect and the one space before it, highest offset first so
    // the lower offsets stay valid.
    for (const { redirect } of [...hits].sort((a, b) => b.redirect.start - a.redirect.start)) {
        const from = suggestion[redirect.start - 1] === " " ? redirect.start - 1 : redirect.start;
        suggestion = suggestion.slice(0, from) + suggestion.slice(redirect.start + redirect.text.length);
    }

    return { matched, index: statement.start, suggestion };
}

// ---------------------------------------------------------------------------
// Coverage: another command in the same call prints the path's error
// ---------------------------------------------------------------------------

// The index of the `"` that closes the double-quoted string opening at `i`.
function closingQuote(command: string, i: number, end: number): number {
    for (let j = i + 1; j < end; j++) {
        const c = command[j];

        if (c === "\\") {
            j++;
        } else if (c === '"') {
            return j;
        } else if (c === "`" || (c === "$" && (command[j + 1] === "(" || command[j + 1] === "{"))) {
            j = groupEnd(command, j, end) - 1;
        }
    }

    return end;
}

// The index just past the `$(…)`, `<(…)`, `${…}` or backtick group opening at `i`.
function groupEnd(command: string, i: number, end: number): number {
    if (command[i] === "`") {
        const close = command.indexOf("`", i + 1);
        return close === -1 || close >= end ? end : close + 1;
    }

    const open = command[i + 1];
    const close = open === "(" ? ")" : "}";
    let depth = 0;

    for (let j = i + 1; j < end; j++) {
        const c = command[j];

        if (c === "\\") {
            j++;
        } else if (c === "'") {
            const q = command.indexOf("'", j + 1);

            if (q === -1 || q >= end) {
                return end;
            }

            j = q;
        } else if (c === '"') {
            j = closingQuote(command, j, end);
        } else if (c === open) {
            depth++;
        } else if (c === close && --depth === 0) {
            return j + 1;
        }
    }

    return end;
}

interface ElementWords {
    words: string[];
    /** Whether the element ends in `|&`, which pipes its stderr along with its stdout. */
    pipesStderr: boolean;
}

// The words of the pipeline element at `start` as the shell splits them, read
// from the original command: the cleaned text blanks a quoted operand
// (`"$L/Archive"` scans as `$L`). Quotes and backslashes are removed, `$(…)`,
// `${…}` and backticks stay whole. Stops at an unquoted `|`, `;`, `&`, `(`, `)`,
// `#` or newline, and at the end of the `sh -c` body that holds `start`. In a
// double-quoted body, the backslashes the outer shell removes go first.
function elementWords(scan: ShellScan, start: number): ElementWords {
    const body = scan.executableRanges
        .filter((range) => start >= range.start && start < range.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];

    if (body && scan.command[body.start - 1] === '"') {
        const text = scan.command
            .slice(start, body.end)
            .replace(/\\([$`"\\\n])/g, (_, c: string) => (c === "\n" ? "" : c));
        return readWords(text, 0, text.length);
    }

    return readWords(scan.command, start, body?.end ?? scan.command.length);
}

function readWords(command: string, from: number, end: number): ElementWords {
    const words: string[] = [];
    let word: string | null = null;
    let pipesStderr = false;
    let i = from;

    while (i < end) {
        const ch = command[i];

        if (ch === "\\") {
            word = (word ?? "") + (command[i + 1] === "\n" ? "" : (command[i + 1] ?? ""));
            i += 2;
        } else if (ch === "'") {
            const close = command.indexOf("'", i + 1);
            const stop = close === -1 || close > end ? end : close;
            word = (word ?? "") + command.slice(i + 1, stop);
            i = stop + 1;
        } else if (ch === '"') {
            const stop = closingQuote(command, i, end);
            word =
                (word ?? "") +
                command.slice(i + 1, stop).replace(/\\([$`"\\\n])/g, (_, c: string) => (c === "\n" ? "" : c));
            i = stop + 1;
        } else if (
            ch === "`" ||
            ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") ||
            (ch === "$" && command[i + 1] === "{")
        ) {
            const stop = groupEnd(command, i, end);
            word = (word ?? "") + command.slice(i, stop);
            i = stop;
        } else if (ch === " " || ch === "\t") {
            if (word !== null) {
                words.push(word);
                word = null;
            }

            i++;
        } else if (
            ch === "\n" ||
            ch === "|" ||
            ch === ";" ||
            ch === "(" ||
            ch === ")" ||
            (ch === "#" && word === null) ||
            (ch === "&" && !(word !== null && /[<>]$/.test(word)) && command[i + 1] !== ">")
        ) {
            pipesStderr = ch === "|" && command[i + 1] === "&";
            break;
        } else {
            word = (word ?? "") + ch;
            i++;
        }
    }

    if (word !== null) {
        words.push(word);
    }

    return { words, pipesStderr };
}

interface ProgramFlags {
    /** Short flags that take a value: the rest of the cluster (`-d1`) or the next word (`-d 1`). */
    short: string;
    /** Long flags that take the next word as their value, unless written `--flag=value`. */
    long: ReadonlySet<string>;
}

interface Positionals {
    words: string[];
    /** Every flag seen, a cluster split into its letters (`-ie` gives `-i` and `-e`). */
    flags: Set<string>;
}

function positionals(args: readonly string[], program: ProgramFlags): Positionals {
    const words: string[] = [];
    const flags = new Set<string>();

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            words.push(...args.slice(i + 1));
            break;
        }

        if (arg.startsWith("--")) {
            const [flag = ""] = arg.split("=", 1);
            flags.add(flag);

            if (program.long.has(flag) && !arg.includes("=")) {
                i++;
            }

            continue;
        }

        if (arg.startsWith("-") && arg.length > 1) {
            for (let k = 1; k < arg.length; k++) {
                flags.add(`-${arg[k]}`);

                if (program.short.includes(arg[k])) {
                    if (k === arg.length - 1) {
                        i++;
                    }

                    break;
                }
            }

            continue;
        }

        words.push(arg);
    }

    return { words, flags };
}

// find [-H|-L|-P|-E|-X|-d|-s|-x] [-f path] <start points…> <expression>: the
// start points end at the first word that starts with `-`, or is `(` or `!`.
function findStartPoints(args: readonly string[]): string[] {
    const points: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (points.length === 0 && /^-[HLPEXdsx]+$/.test(arg)) {
            continue;
        }

        if (arg === "-f") {
            points.push(...args.slice(i + 1, i + 2));
            i++;
            continue;
        }

        if (arg.startsWith("-") || arg === "(" || arg === "!") {
            break;
        }

        points.push(arg);
    }

    return points;
}

const FD_FLAGS: ProgramFlags = {
    short: "edEtxXjSco",
    long: new Set([
        "--extension",
        "--type",
        "--max-depth",
        "--min-depth",
        "--exact-depth",
        "--exclude",
        "--exec",
        "--exec-batch",
        "--threads",
        "--base-directory",
        "--search-path",
        "--color",
        "--size",
        "--changed-within",
        "--changed-before",
        "--owner",
        "--max-results",
        "--format",
        "--ignore-file",
        "--path-separator",
        "--batch-size",
        "--and",
    ]),
};
const RG_FLAGS: ProgramFlags = {
    short: "ABCdEefgjMmrtT",
    long: new Set([
        "--after-context",
        "--before-context",
        "--context",
        "--max-depth",
        "--encoding",
        "--regexp",
        "--file",
        "--glob",
        "--iglob",
        "--threads",
        "--max-columns",
        "--max-count",
        "--replace",
        "--type",
        "--type-not",
        "--type-add",
        "--sort",
        "--sortr",
        "--color",
        "--colors",
        "--max-filesize",
        "--pre",
        "--pre-glob",
        "--ignore-file",
        "--engine",
        "--path-separator",
    ]),
};
const GREP_FLAGS: ProgramFlags = {
    short: "ABCDdefm",
    long: new Set([
        "--regexp",
        "--file",
        "--max-count",
        "--include",
        "--exclude",
        "--exclude-dir",
        "--directories",
        "--devices",
        "--context",
        "--after-context",
        "--before-context",
    ]),
};

interface Operands {
    paths: string[];
    /** Whether it reads a folder's contents: it then fails on a folder it may not list, and prints its children. */
    lists: boolean;
}

// rg and grep: the first positional is the pattern, unless -e or -f gave it, or
// `rg --files` takes none.
function searchOperands(
    args: readonly string[],
    program: ProgramFlags,
    lists: (flags: Set<string>) => boolean
): Operands {
    const { words, flags } = positionals(args, program);
    const byFlag = ["-e", "-f", "--regexp", "--file", "--files"].some((flag) => flags.has(flag));
    return { paths: byFlag ? words : words.slice(1), lists: lists(flags) };
}

// The paths a command names, per command word. Every command here prints a
// path's error (missing, refused) when it names that path with stderr visible.
// `stat`, `ls -d` and `find -maxdepth 0` read only the entry itself, which
// succeeds on a folder that cannot be listed.
const PATH_OPERANDS: ReadonlyMap<string, (args: readonly string[]) => Operands> = new Map([
    [
        "ls",
        (args: readonly string[]) => {
            const { words, flags } = positionals(args, { short: "D", long: new Set() });
            return { paths: words, lists: !flags.has("-d") && !flags.has("--directory") };
        },
    ],
    [
        "du",
        (args: readonly string[]) => ({
            paths: positionals(args, { short: "BdIt", long: new Set() }).words,
            lists: true,
        }),
    ],
    [
        "stat",
        (args: readonly string[]) => ({
            paths: positionals(args, { short: "ftc", long: new Set(["--format", "--printf"]) }).words,
            lists: false,
        }),
    ],
    [
        "find",
        (args: readonly string[]) => ({
            paths: findStartPoints(args),
            lists: !args.some((arg, i) => arg === "-maxdepth" && args[i + 1] === "0"),
        }),
    ],
    // fd [pattern] [path…]: no path means the folder it runs in.
    ["fd", (args: readonly string[]) => ({ paths: positionals(args, FD_FLAGS).words.slice(1), lists: true })],
    ["rg", (args: readonly string[]) => searchOperands(args, RG_FLAGS, () => true)],
    [
        "grep",
        (args: readonly string[]) =>
            searchOperands(args, GREP_FLAGS, (flags) =>
                ["-r", "-R", "--recursive", "--dereference-recursive"].some((flag) => flags.has(flag))
            ),
    ],
]);

// Producers whose count fails only on a path, so a sibling naming that path
// shows the failure. git, tsgo, rg or sqlite3 can fail on a revision, a flag or
// a query no sibling prints.
const COVERABLE_PRODUCERS = new Set(["ls", "du", "stat", "find", "fd"]);

// `>`, `2>>`, `&>`, `>&2`, `2>&-`, `<<<`: the fd, the operator and an attached target.
const REDIRECT = /^(\d*|&)(>>|>&|>\||<<<|<<-?|<&|<>|>|<)(.*)$/;

const STREAMS = new Set(["stdout", "stderr"]);

interface Redirected {
    args: string[];
    /** Where fd 1 and fd 2 end up: "stdout" or "stderr" for the streams the command was given, else a file or "closed". */
    out: string;
    err: string;
}

function replayRedirects(words: readonly string[]): Redirected {
    const args: string[] = [];
    let out = "stdout";
    let err = "stderr";

    for (let i = 0; i < words.length; i++) {
        const m = REDIRECT.exec(words[i]);

        if (!m) {
            args.push(words[i]);
            continue;
        }

        const [, fd = "", op = ""] = m;
        let target = m[3] ?? "";

        if (target === "") {
            target = words[i + 1] ?? "";
            i++;
        }

        if (op.startsWith("<")) {
            continue;
        }

        // `>&1` copies fd 1 as it is now, `>&-` closes, `>&file` and `&>file` move both.
        let dest = target;

        if (op === ">&" && /^\d$/.test(target)) {
            dest = target === "1" ? out : target === "2" ? err : `&${target}`;
        } else if (op === ">&" && target === "-") {
            dest = "closed";
        }

        if (fd === "&" || (op === ">&" && fd === "" && !/^(?:\d|-)$/.test(target))) {
            out = dest;
            err = dest;
        } else if (fd === "2") {
            err = dest;
        } else if (fd === "" || fd === "1") {
            out = dest;
        }
    }

    return { args, out, err };
}

interface ParsedElement extends Operands {
    word: string;
    /** Where its stderr goes before its pipeline: "stderr", "stdout" (into the pipe), or a file. */
    err: string;
    /** Whether xargs runs it, which on an empty input runs nothing. */
    viaXargs: boolean;
}

function parseElement(scan: ShellScan, element: Span): ParsedElement | null {
    const { words, pipesStderr } = elementWords(scan, element.start);
    const cmd = commandTokenIndex(words.map((text) => ({ text, start: 0 })));
    const operandsOf = cmd === -1 ? undefined : PATH_OPERANDS.get(commandWord(words[cmd]));

    if (!operandsOf) {
        return null;
    }

    // `a |& b` is `a 2>&1 | b`, applied after a's own redirects.
    const own = words.slice(cmd + 1);
    const { args, err } = replayRedirects(pipesStderr ? [...own, "2>&1"] : own);

    return {
        word: commandWord(words[cmd]),
        ...operandsOf(args),
        err,
        viaXargs: words.slice(0, cmd).some((word) => commandWord(word) === "xargs"),
    };
}

// Elements that print the lines they read, so an error line merged into the
// pipe (`2>&1 | head`) still shows. A counter, `grep -q`, a filter or a
// transform that cuts the line does not.
const PRINTS_ITS_INPUT = new Set([
    "head",
    "tail",
    "cat",
    "tee",
    "sort",
    "uniq",
    "column",
    "nl",
    "less",
    "more",
    "fold",
    "sed",
    "grep",
    "egrep",
    "fgrep",
    "rg",
]);

function printsItsInput(scan: ShellScan, element: Span): boolean {
    const { words } = elementWords(scan, element.start);
    const cmd = commandTokenIndex(words.map((text) => ({ text, start: 0 })));

    if (
        cmd === -1 ||
        words.slice(0, cmd).some((word) => commandWord(word) === "xargs") ||
        passesNothing(element.text)
    ) {
        return false;
    }

    const word = commandWord(words[cmd]);
    const { args, out } = replayRedirects(words.slice(cmd + 1));
    const short = args.filter((arg) => /^-[A-Za-z]+$/.test(arg)).join("");

    if (!PRINTS_ITS_INPUT.has(word) || out !== "stdout") {
        return false;
    }

    if (word === "sed") {
        return !/n/.test(short) && !args.includes("--quiet") && !args.includes("--silent");
    }

    if (word === "tail") {
        // `tail -n +2` drops the first line, which is where a lone error sits.
        return !args.some((arg) => Number(/\+(\d+)$/.exec(arg)?.[1] ?? 0) > 1);
    }

    if (word === "uniq") {
        return !/[du]/.test(short);
    }

    if (!["grep", "egrep", "fgrep", "rg"].includes(word)) {
        return true;
    }

    // A search keeps the error line only when it inverts the match and prints lines.
    return (
        (/v/.test(short) || args.includes("--invert-match")) &&
        !/[qclLo]/.test(short) &&
        !args.some((arg) => /^--(?:quiet|silent|count|files-with|files-without|only-matching)/.test(arg))
    );
}

// ---------------------------------------------------------------------------
// The call's structure: when each statement runs, and where its output goes
// ---------------------------------------------------------------------------

/** The redirects of a compound command (`} 2>/dev/null`, `done < f 2>&1 | head`) or of an `exec`. */
interface FdLayer {
    out: string;
    err: string;
    /** The pipeline elements after the compound command, which read its stdout. */
    downstream: Span[];
}

interface ShellUnit {
    span: Span;
    end: number;
    /** A `$(…)` or backtick body: its stdout is captured, not shown. */
    capture: boolean;
    /** The `sh -c` body this unit is the top level of. */
    body?: { start: number; end: number };
    /** The statement of the enclosing unit that this unit sits in. */
    host?: StatementInfo;
}

interface StatementInfo {
    span: Span;
    unit: ShellUnit;
    /** Where the next statement of the unit starts, or the unit's end. */
    end: number;
    /** Ids of the conditions it runs under: an `&&` or `||` arm, an `if` or `case` branch, a loop or function body. */
    conds: number[];
    /** The compound commands around it, innermost first. */
    compounds: FdLayer[];
    /** The `exec` redirects before it, latest first. */
    execs: FdLayer[];
}

interface Frame {
    kind: "group" | "if" | "loop" | "case";
    conds: number[];
    /** The current branch of an `if` or `case`, or the body of a loop after `do`. */
    branch: number | null;
    members: StatementInfo[];
}

const OPENS: ReadonlyMap<string, Frame["kind"]> = new Map([
    ["if", "if"],
    ["while", "loop"],
    ["until", "loop"],
    ["for", "loop"],
    ["select", "loop"],
    ["repeat", "loop"],
    ["case", "case"],
]);
const CLOSES: ReadonlyMap<string, Frame["kind"]> = new Map([
    ["fi", "if"],
    ["done", "loop"],
    ["esac", "case"],
]);
const BRANCHES: ReadonlyMap<string, Frame["kind"]> = new Map([
    ["then", "if"],
    ["elif", "if"],
    ["else", "if"],
    ["do", "loop"],
]);

// The separators between two statements. `()` is a function definition; `;`,
// `&` and newline only end the redirects of a group that just closed.
const STRUCTURE_TOKEN = /&&|\|\||;;|\(\s*\)|[(){};&\n]/g;

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** The lines a shell reads from a heredoc, with the words and the pipe of that shell's element. */
interface ShellHeredoc {
    start: number;
    end: number;
    words: string[];
    downstream: Span[];
}

// `bash <<'B' 2>/dev/null`: the scan keeps the body's statements in the same
// unit and blanks the operator and the delimiter line, so the body is found in
// the original command, from the line after the operator to the delimiter line.
function shellHeredoc(scan: ShellScan, elements: readonly Span[]): ShellHeredoc | null {
    for (let k = 0; k < elements.length; k++) {
        if (!SHELLS.has(simpleCommandWord(elements[k].text))) {
            continue;
        }

        const { words } = elementWords(scan, elements[k].start);
        const at = words.findIndex((word) => /^<<-?(?!<)/.test(word));
        const op = /^<<(-?)(.*)$/.exec(words[at] ?? "");
        const delim = op ? op[2] || (words[at + 1] ?? "") : "";
        const start = scan.command.indexOf("\n", elements[k].start) + 1;

        if (!op || delim === "" || start === 0) {
            continue;
        }

        let end = scan.command.length;

        for (let line = start; line < scan.command.length; ) {
            const eol = scan.command.indexOf("\n", line);
            const stop = eol === -1 ? scan.command.length : eol;
            const text = scan.command.slice(line, stop);

            if ((op[1] === "-" ? text.replace(/^\t+/, "") : text) === delim) {
                end = line;
                break;
            }

            line = stop + 1;
        }

        return { start, end, words, downstream: elements.slice(k + 1) };
    }

    return null;
}

function walkUnit(scan: ShellScan, unit: ShellUnit, nextId: () => number): StatementInfo[] {
    const stack: Frame[] = [];
    const execs: FdLayer[] = [];
    const infos: StatementInfo[] = [];
    let pending: number[] = [];
    let heredoc: (ShellHeredoc & { conds: number[]; members: StatementInfo[] }) | null = null;
    let at = unit.span.start;

    const wrap = (members: readonly StatementInfo[], words: readonly string[], downstream: Span[]) => {
        const { out, err } = replayRedirects(words);

        for (const member of members) {
            member.compounds.push({ out, err, downstream });
        }
    };

    // Applies the separators up to `to`, and returns the group a closing `}` or
    // `)` ended when nothing follows it, so the next statement holds its redirects.
    const separators = (to: number): Frame | null => {
        let closed: Frame | null = null;

        for (const [token] of unit.span.text
            .slice(at - unit.span.start, to - unit.span.start)
            .matchAll(STRUCTURE_TOKEN)) {
            closed = null;

            if (token === "&&" || token === "||" || (token.length > 1 && token.startsWith("("))) {
                pending.push(nextId());
            } else if (token === ";;") {
                const top = stack.at(-1);

                if (top?.kind === "case") {
                    top.branch = nextId();
                }
            } else if (token === "(" || token === "{") {
                stack.push({ kind: "group", conds: pending, branch: null, members: [] });
                pending = [];
            } else if ((token === ")" || token === "}") && stack.at(-1)?.kind === "group") {
                closed = stack.pop() ?? null;
            }
        }

        return closed;
    };

    for (const statement of splitStatements(unit.span)) {
        const closed = separators(statement.start);
        const elements = splitPipeline(statement);
        const first = tokenize(statement)[0]?.text ?? "";
        const top = stack.at(-1);
        const opens = OPENS.get(first);

        if (heredoc && statement.start >= heredoc.end) {
            wrap(heredoc.members, heredoc.words, heredoc.downstream);
            heredoc = null;
        }

        if (closed) {
            // `} 2>/dev/null | head`: this statement is the redirects and the pipe of the group.
            const piped = statement.text.startsWith("|");
            wrap(
                closed.members,
                piped ? [] : elementWords(scan, statement.start).words,
                piped ? elements : elements.slice(1)
            );
        } else if (top && CLOSES.get(first) === top.kind) {
            stack.pop();
            wrap(top.members, elementWords(scan, statement.start).words.slice(1), elements.slice(1));
        } else if (opens) {
            stack.push({ kind: opens, conds: pending, branch: opens === "case" ? nextId() : null, members: [] });
            pending = [];
        } else if (top && BRANCHES.get(first) === top.kind) {
            top.branch = nextId();
        }

        const info: StatementInfo = {
            span: statement,
            unit,
            end: unit.end,
            conds: [...stack.flatMap((f) => (f.branch === null ? f.conds : [...f.conds, f.branch])), ...pending],
            compounds: [],
            execs: [...execs],
        };
        const previous = infos.at(-1);

        if (previous) {
            previous.end = statement.start;
        }

        for (const frame of stack) {
            frame.members.push(info);
        }

        infos.push(info);
        pending = first === "function" ? [nextId()] : [];

        // A heredoc body runs when its shell runs, with that shell's redirects around it.
        if (heredoc && statement.start >= heredoc.start) {
            info.conds.push(...heredoc.conds);
            heredoc.members.push(info);
        } else if (!heredoc) {
            const found = shellHeredoc(scan, elements);
            heredoc = found ? { ...found, conds: info.conds, members: [] } : null;
        }

        if (first === "exec") {
            const { out, err } = replayRedirects(elementWords(scan, statement.start).words.slice(1));
            execs.unshift({ out, err, downstream: [] });
        }

        at = statement.start + statement.text.length;
    }

    separators(unit.end);

    if (heredoc) {
        wrap(heredoc.members, heredoc.words, heredoc.downstream);
    }

    return infos;
}

// Every statement of the call, in the same units as scan.units: the command,
// its substitutions, and each executable body with its substitutions.
function callStructure(scan: ShellScan): StatementInfo[] {
    const units: ShellUnit[] = splitSubstitutions(scan.cleaned).map((span, i) => ({
        span,
        end: span.start + span.text.length,
        capture: i > 0,
    }));

    for (const range of scan.executableRanges) {
        const backtick = scan.command[range.start - 1] === "`";
        const spans = splitSubstitutions(stripShellNoise(scan.command.slice(range.start, range.end)), range.start);

        spans.forEach((span, i) => {
            const body = i === 0 && !backtick ? { body: range } : {};
            units.push({ span, end: span.start + span.text.length, capture: i > 0 || backtick, ...body });
        });
    }

    let id = 0;
    const statements = units.flatMap((unit) => walkUnit(scan, unit, () => id++));

    // The host is the innermost statement whose region holds the unit. It starts
    // strictly before the unit, so the chain of hosts always ends.
    for (const unit of units) {
        unit.host = statements
            .filter((s) => s.unit !== unit && s.span.start < unit.span.start && unit.span.start < s.end)
            .sort((a, b) => b.span.start - a.span.start)[0];
    }

    return statements;
}

function allConds(info: StatementInfo): number[] {
    return info.unit.host ? [...info.conds, ...allConds(info.unit.host)] : info.conds;
}

// Whether a line the statement writes to `stream` ("stdout" or "stderr")
// reaches the terminal: through the compound commands around it, the `exec`
// redirects before it, and the capture or `sh -c` body it sits in.
function reaches(scan: ShellScan, info: StatementInfo, stream: string): boolean {
    let dest = stream;

    for (const layer of [...info.compounds, ...info.execs]) {
        dest = dest === "stderr" ? layer.err : layer.out;

        if (!STREAMS.has(dest) || (dest === "stdout" && !layer.downstream.every((e) => printsItsInput(scan, e)))) {
            return false;
        }
    }

    const { unit } = info;
    const { body, host } = unit;

    if (unit.capture) {
        return dest === "stderr" && (!host || reaches(scan, host, "stderr"));
    }

    if (!body) {
        return true;
    }

    if (!host) {
        return false;
    }

    // `zsh -c '…' 2>/dev/null | head`: the redirects after the body, then the rest of its pipeline.
    const elements = splitPipeline(host.span);
    const k = elements.findLastIndex((e) => e.start <= body.start);
    const close = scan.command[body.end];
    const after = elementWords(scan, close === '"' || close === "'" ? body.end + 1 : body.end);
    const { out, err } = replayRedirects(after.pipesStderr ? [...after.words, "2>&1"] : after.words);
    dest = dest === "stderr" ? err : out;

    if (!STREAMS.has(dest) || (dest === "stdout" && !elements.slice(k + 1).every((e) => printsItsInput(scan, e)))) {
        return false;
    }

    return reaches(scan, host, dest);
}

// Whether the stderr of element `k` reaches the terminal, directly or merged
// into a pipe that prints it.
function stderrShown(scan: ShellScan, info: StatementInfo, elements: readonly Span[], k: number, err: string): boolean {
    if (err === "stdout" && !elements.slice(k + 1).every((e) => printsItsInput(scan, e))) {
        return false;
    }

    return STREAMS.has(err) && reaches(scan, info, err);
}

// Paths that match only themselves: listing `~` or `.` says nothing about a
// folder under it.
const BARE_ROOT = /^(?:\.|\/|~|\$HOME|\$\{HOME\}|\/(?:Users|home)\/[^/]+)$/;

// Whether a sibling naming `named` prints an error for `operand`. The same path
// counts when the sibling reads it as deeply as the producer does. A path under
// the operand fails when the operand is missing or refused. A parent counts
// only when the sibling lists it.
function names(operand: string, producerLists: boolean, named: string, siblingLists: boolean): boolean {
    const a = operand.replace(/(.)\/+$/, "$1");
    const b = named.replace(/(.)\/+$/, "$1");

    if (a === b) {
        return siblingLists || !producerLists;
    }

    if (BARE_ROOT.test(a) || BARE_ROOT.test(b)) {
        return false;
    }

    return b.startsWith(`${a}/`) || (siblingLists && a.startsWith(`${b}/`));
}

// Whether every hit's producer is ls, du, stat, find or fd, and every path it
// names is named by another listing or search that runs whenever the producer
// runs and whose stderr reaches the terminal.
function everyHitCovered(scan: ShellScan, hits: readonly DevnullHit[]): boolean {
    const producers = hits.map((hit) => parseElement(scan, hit.producer));

    if (producers.some((p) => !p || !COVERABLE_PRODUCERS.has(p.word) || p.paths.length === 0)) {
        return false;
    }

    const statements = callStructure(scan);
    const siblings: Array<{ info: StatementInfo; parsed: ParsedElement }> = [];

    for (const info of statements) {
        const elements = splitPipeline(info.span);

        for (let k = 0; k < elements.length; k++) {
            const element = elements[k];
            // The producer, and an element after it that runs on its output.
            const own = hits.some(
                (hit) => hit.statement.start === info.span.start && element.start >= hit.producer.start
            );

            if (own || !PATH_OPERANDS.has(simpleCommandWord(element.text))) {
                continue;
            }

            const parsed = parseElement(scan, element);

            if (parsed && !parsed.viaXargs && stderrShown(scan, info, elements, k, parsed.err)) {
                siblings.push({ info, parsed });
            }
        }
    }

    return hits.every((hit, i) => {
        const producer = producers[i];
        const at = statements.find((s) => s.span.start === hit.statement.start);

        if (!producer || !at) {
            return false;
        }

        const runs = new Set(allConds(at));
        const witnesses = siblings.filter((s) => allConds(s.info).every((cond) => runs.has(cond)));

        return producer.paths.every((path) =>
            witnesses.some((s) => s.parsed.paths.some((named) => names(path, producer.lists, named, s.parsed.lists)))
        );
    });
}

// The counted hits, when their coverage is `covered`: the block and the context
// rule split one set of hits, so a command never gets both.
function countedMatch(scan: ShellScan, covered: boolean): ShellMatch | null {
    const hits = devnullHits(scan, (later) => later.some(isCounter));

    if (hits.length === 0 || everyHitCovered(scan, hits) !== covered) {
        return null;
    }

    return matchFromHits(scan, hits);
}

export const stderrDiscardedThenCounted: ShellRule = {
    id: "stderr-discarded-then-counted",
    kind: "misread",
    title: "2>/dev/null then a count: a failure reads as 0 or a blank",
    severity: "block",
    why:
        "stderr is discarded, so a permission error, a wrong path or an unknown flag prints nothing on " +
        "stdout. `wc -l` and `grep -c` then print 0, and `rg -c` prints nothing at all. Either is " +
        'indistinguishable from a real empty result, and it gets read as "there are none". Piping stdout ' +
        "never hides stderr. If you expect some paths to be absent, test for them, so that absence prints " +
        "a word and a typo still prints an error.",
    wrong: "ls ~/Downloads/*.har 2>/dev/null | wc -l",
    right:
        "ls ~/Downloads/*.har | wc -l   # or keep stderr readable: ls … 2>/tmp/err | wc -l; cat /tmp/err" +
        '   # a path that may be absent: [ -d "$p" ] && ls "$p" | wc -l || echo "absent: $p"',
    evidence:
        "932 calls in 90 days, 45 sampled, none where the redirect was needed. CLAUDE.md records three " +
        "wrong conclusions on separate days, including `ls ~/Downloads/*.har 2>/dev/null | wc -l` printing " +
        "0 while eight files existed (macOS TCC had refused the listing).",
    detect(scan) {
        return countedMatch(scan, false);
    },
};

export const stderrDiscardedThenCountedCovered: ShellRule = {
    id: "stderr-discarded-then-counted-covered",
    kind: "misread",
    title: "2>/dev/null then a count, with the same path listed elsewhere in the call with stderr visible",
    severity: "context",
    why:
        "stderr is discarded before the count, so the count can still read a failure as 0 (or as a blank " +
        "from `rg -c`). Another command in this call reads the same path, a path under it, or lists a folder " +
        "above it, runs whenever the count runs, and keeps stderr visible, so a missing path or a refused " +
        "listing prints its error there. Read that output before you trust the count.",
    wrong: 'find /x -type l 2>&1 | head -20; echo "n=$(find /x -type l 2>/dev/null | wc -l)"',
    right: 'find /x -type l 2>&1 | head -20; echo "n=$(find /x -type l | wc -l)"',
    evidence:
        "The 2026-11-01 audit of the guard log: in 11 of 40 logged counted blocks, an ls, du, find or fd of the " +
        "same path, its parent or a child printed the missing-path or denial error in the same call, and both " +
        "judges rated each block maybe-incorrect. The rule takes 10 of them: in the 11th the only sibling was " +
        "`ls -lOd`, which prints a missing path but succeeds on a folder it may not list.",
    detect(scan) {
        return countedMatch(scan, true);
    },
};

export const stderrDiscardedThenRead: ShellRule = {
    id: "stderr-discarded-then-read",
    kind: "misread",
    title: "2>/dev/null then head/tail/grep/…: empty output may be an error, not an absence",
    severity: "context",
    why:
        'stderr is discarded before the output is read, so "the command failed" (permission denied, ' +
        'wrong path, unknown flag) and "no data" produce the same empty result. If the output comes ' +
        "back empty, you cannot tell which happened. Piping stdout already leaves stderr visible.",
    wrong: "ls ~/Library/Developer/CoreSimulator/Devices/ 2>/dev/null | head -20",
    right: "ls ~/Library/Developer/CoreSimulator/Devices/ | head -20",
    evidence:
        "16,774 calls in 90 days (8% of all Bash calls), about three in four the reading shape; the rest " +
        "silence a chatty tool on purpose, hence context rather than block.",
    // A pipeline with a counter downstream is the counted rule's, not this one's.
    detect(scan) {
        const hits = devnullHits(scan, (later) => !later.some(isCounter) && later.some(isReader));
        return hits.length > 0 ? matchFromHits(scan, hits) : null;
    },
};

export const devnullRules: readonly ShellRule[] = [
    stderrDiscardedThenCounted,
    stderrDiscardedThenCountedCovered,
    stderrDiscardedThenRead,
];
