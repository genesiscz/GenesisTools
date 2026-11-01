// `2>/dev/null` rules: discarding stderr and then reading the (possibly empty)
// stdout makes "the command failed" and "there is no data" the same output.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import {
    cleanedBody,
    commandTokenIndex,
    commandWord,
    originalSlice,
    RESERVED_PREFIX,
    readWords,
    type ShellScan,
    type Span,
    simpleCommandWord,
    splitPipeline,
    splitStatements,
    splitSubstitutions,
    tokenize,
    wordsFrom,
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

const AWKS = new Set(["awk", "gawk", "mawk"]);

function isCounter(scan: ShellScan, element: Span): boolean {
    const word = simpleCommandWord(element, scan.command);

    if (word === "wc") {
        return true;
    }

    if (AWKS.has(word)) {
        return awkCounts(wordsFrom(scan, element.start).words);
    }

    if (word !== "grep" && word !== "egrep" && word !== "fgrep" && word !== "rg") {
        return false;
    }

    return tokenize(element).some(
        (t) => t.text === "--count" || t.text === "--count-matches" || /^-[A-Za-z]*c[A-Za-z]*$/.test(t.text)
    );
}

// An awk that prints only in its END block turns an empty input into a number
// (`END {print s}` prints 0), like `wc -l`. A program read with -f is unknown.
function awkCounts(words: readonly string[]): boolean {
    const cmd = commandTokenIndex(words.map((text) => ({ text, start: 0 })));
    const { words: operands, flags } = positionals(words.slice(cmd + 1), { short: "Fvf", long: new Set() });
    const program = (operands[0] ?? "").replace(/"(?:[^"\\]|\\.)*"/g, '""');

    return !flags.has("-f") && /\bEND\s*\{/.test(program) && !mainRulesPrint(program);
}

// Whether a rule outside BEGIN and END prints: its action has print or printf,
// or it is a pattern with no action (`/x/;`, `NR<5`), which prints each line it matches.
function mainRulesPrint(program: string): boolean {
    let pattern = "";

    for (let j = 0; j < program.length; j++) {
        const c = program[j];

        if (c === "{") {
            const start = j;
            let depth = 0;

            while (j < program.length && !(program[j] === "}" && --depth === 0)) {
                depth += program[j] === "{" ? 1 : 0;
                j++;
            }

            const special = /\b(?:BEGIN|END)\s*$/.exec(pattern);

            if (special ? pattern.slice(0, special.index).trim() !== "" : /\bprintf?\b/.test(program.slice(start, j))) {
                return true;
            }

            pattern = "";
        } else if (c === ";" || c === "\n") {
            if (pattern.trim() !== "") {
                return true;
            }

            pattern = "";
        } else {
            pattern += c;
        }
    }

    return pattern.trim() !== "";
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

// The elements after element `k` that read its output: up to a zero count.
function laterElements(elements: readonly Span[], k: number): Span[] {
    const later = elements.slice(k + 1);
    const cut = later.findIndex((e) => passesNothing(e.text));
    return cut === -1 ? later : later.slice(0, cut);
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
function devnullHits(scan: ShellScan, consumes: (later: Span[]) => boolean): DevnullHit[] {
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

                if (redirects.length === 0 || QUIET_STDERR_PRODUCERS.has(simpleCommandWord(producer, scan.command))) {
                    continue;
                }

                if (!consumes(laterElements(elements, k))) {
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

interface Edit {
    from: number;
    to: number;
    text: string;
}

// Drops each redirect. With `wrapCompilers`, a tsc or tsgo producer is wrapped
// instead: it prints its errors on stdout, where the counter drops them, so the
// corrected command prints its exit status on stderr.
function matchFromHits(scan: ShellScan, hits: readonly DevnullHit[], wrapCompilers = false): ShellMatch {
    const { statement } = hits[0];
    const matched = originalSlice(scan, statement.start, statement.start + statement.text.length);
    const edits: Edit[] = [];
    const wrapped = new Set<number>();

    for (const hit of hits) {
        const echo = wrapCompilers ? statusEcho(scan, hit.producer) : null;

        if (echo === null) {
            edits.push(dropping(scan.command, hit.redirect));
        } else if (!wrapped.has(hit.producer.start)) {
            wrapped.add(hit.producer.start);
            edits.push(wrapping(scan, hit, hits, echo));
        }
    }

    // Highest offset first, so the lower offsets stay valid.
    let suggestion = scan.command;

    for (const { from, to, text } of edits.sort((a, b) => b.from - a.from)) {
        suggestion = suggestion.slice(0, from) + text + suggestion.slice(to);
    }

    return { matched, index: statement.start, suggestion };
}

// Drops the redirect and the one space before it.
function dropping(command: string, redirect: Span): Edit {
    const from = command[redirect.start - 1] === " " ? redirect.start - 1 : redirect.start;
    return { from, to: redirect.start + redirect.text.length, text: "" };
}

// `{ <producer without its redirects>; echo "tsgo rc=$?" >&2; } |`, through the
// pipe after it. A leading `do` or `then` stays outside the braces, and `|&`
// becomes `|`, so the status line does not go into the counter.
function wrapping(scan: ShellScan, hit: DevnullHit, hits: readonly DevnullHit[], echo: string): Edit {
    const { producer, statement } = hit;
    const tokens = tokenize(producer);
    const first = tokens.findIndex((t, i) => i === tokens.length - 1 || !RESERVED_PREFIX.has(t.text));
    const from = tokens[first].start;
    // A counted producer always has a later element, so the pipe is there.
    const pipe = statement.start + statement.text.indexOf("|", producer.start - statement.start + producer.text.length);
    let text = scan.command.slice(from, pipe).trimEnd();
    const own = hits.filter((h) => h.producer.start === producer.start);

    for (const { redirect } of own.sort((a, b) => b.redirect.start - a.redirect.start)) {
        const cut = dropping(scan.command, redirect);
        text = text.slice(0, cut.from - from) + text.slice(cut.to - from);
    }

    return { from, to: pipe + (scan.command[pipe + 1] === "&" ? 2 : 1), text: `{ ${text}; ${echo}; } |` };
}

// Package runners and the word after them that makes them one (`bun x`).
const RUNNERS: ReadonlyMap<string, string | null> = new Map([
    ["bunx", null],
    ["npx", null],
    ["bun", "x"],
    ["pnpm", "dlx"],
    ["yarn", "dlx"],
    ["npm", "exec"],
]);

// The status line for a tsc or tsgo producer (run directly or through a package
// runner), escaped once inside a double-quoted `sh -c "…"` body or an unquoted
// heredoc a shell reads, whose `$?` the shell around it expands first. Null for
// any other producer, inside a backtick or two such layers, and in an unquoted
// heredoc whose command is not a shell, where the corrected command only drops
// the redirect.
function statusEcho(scan: ShellScan, producer: Span): string | null {
    const { words } = wordsFrom(scan, producer.start);
    let at = commandTokenIndex(words.map((text) => ({ text, start: 0 })));
    const sub = RUNNERS.get(commandWord(words[at] ?? ""));

    // The program is the first word that is not a flag or the value of -p/--package.
    if (sub === null || (sub !== undefined && words[at + 1] === sub)) {
        at += sub ? 2 : 1;

        while (words[at]?.startsWith("-")) {
            at += words[at] === "-p" || words[at] === "--package" ? 2 : 1;
        }
    }

    const word = commandWord(words[at] ?? "");

    if (word !== "tsc" && word !== "tsgo") {
        return null;
    }

    // A layer whose `$?` the shell around it expands first, unless that shell
    // also runs the substitution the producer sits in.
    const expands = (start: number, end: number) =>
        producer.start >= start && producer.start < end && !substitutedFrom(scan, start, producer);
    const ranges = scan.executableRanges.filter((r) => producer.start >= r.start && producer.start < r.end);
    const doubled = ranges.filter((r) => scan.command[r.start - 1] === '"' && expands(r.start, r.end)).length;
    const heredocs = scan.heredocs.filter((h) => !h.quoted && h.fed && expands(h.start, h.end));

    if (
        ranges.some((r) => scan.command[r.start - 1] === "`") ||
        doubled + heredocs.length > 1 ||
        heredocs.some((h) => !shellReads(scan, h.opener))
    ) {
        return null;
    }

    if (heredocs.length === 1) {
        return `echo "${word} rc=\\$?" >&2`;
    }

    return doubled === 1 ? `echo \\"${word} rc=\\$?\\" >&2` : `echo "${word} rc=$?" >&2`;
}

// Whether the producer sits in a `$(…)` that opens at or after `from` with a `$`
// no backslash escapes: the shell that expands the layer from `from` runs it.
// The scan reads `\\$(` in a heredoc as the inner shell's `\$(`, so a statement
// that follows such a `$(` without being its unit's first counts on its own.
function substitutedFrom(scan: ShellScan, from: number, producer: Span): boolean {
    const { command } = scan;
    const holds = (s: Span) => producer.start >= s.start && producer.start < s.start + s.text.length;
    const opens = (start: number) => {
        let open = start;

        while (open > 0 && /\s/.test(command[open - 1])) {
            open--;
        }

        let slashes = 0;

        while (command[open - 3 - slashes] === "\\") {
            slashes++;
        }

        return open - 2 >= from && command.slice(open - 2, open) === "$(" && slashes % 2 === 0;
    };

    return scan.units.some((statements) =>
        statements.some((s, k) => opens(s.start) && (k === 0 ? statements.some(holds) : holds(s)))
    );
}

// Whether the command before a heredoc's `<<` is a shell. Its line starts at a
// newline of the cleaned text, where a backslash-newline is blank, or at the `(`
// that opens the substitution or subshell around it.
function shellReads(scan: ShellScan, opener: number): boolean {
    const body = scan.executableRanges
        .filter((r) => r.start <= opener && opener < r.end)
        .sort((a, b) => b.start - a.start)[0];
    const base = body?.start ?? 0;
    const cleaned = body ? cleanedBody(scan.command, body) : scan.cleaned;
    let from = opener - base;

    for (let depth = 0; from > 0; from--) {
        const ch = cleaned[from - 1];

        if (ch === ")") {
            depth++;
        } else if (ch === "(" && depth > 0) {
            depth--;
        } else if (depth === 0 && (ch === "(" || ch === "\n")) {
            break;
        }
    }

    const [outer] = splitSubstitutions(cleaned.slice(from, opener - base));
    const element = splitPipeline(splitStatements(outer).at(-1) ?? outer).at(-1);
    return SHELLS.has(simpleCommandWord(element?.text ?? ""));
}

// ---------------------------------------------------------------------------
// Coverage: another command in the same call prints the path's error
// ---------------------------------------------------------------------------

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
    /** Each value a flag took, as `[flag, value]`. */
    values: Array<[string, string]>;
}

function positionals(args: readonly string[], program: ProgramFlags): Positionals {
    const words: string[] = [];
    const flags = new Set<string>();
    const values: Array<[string, string]> = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            words.push(...args.slice(i + 1));
            break;
        }

        if (arg.startsWith("--")) {
            const [flag = ""] = arg.split("=", 1);
            flags.add(flag);

            if (arg.includes("=")) {
                values.push([flag, arg.slice(flag.length + 1)]);
            } else if (program.long.has(flag)) {
                values.push([flag, args[i + 1] ?? ""]);
                i++;
            }

            continue;
        }

        if (arg.startsWith("-") && arg.length > 1) {
            for (let k = 1; k < arg.length; k++) {
                flags.add(`-${arg[k]}`);

                if (program.short.includes(arg[k])) {
                    values.push([`-${arg[k]}`, k === arg.length - 1 ? (args[i + 1] ?? "") : arg.slice(k + 1)]);

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

    return { words, flags, values };
}

// find [-H|-L|-P|-E|-X|-d|-s|-x] [-f path] <start points…> <expression>: the
// start points end at the first word that starts with `-`, or is `(` or `!`.
function findParts(args: readonly string[]): { options: string[]; points: string[]; expression: string[] } {
    const options: string[] = [];
    const points: string[] = [];
    let i = 0;

    for (; i < args.length; i++) {
        const arg = args[i];

        if (points.length === 0 && /^-[HLPEXdsx]+$/.test(arg)) {
            options.push(arg);
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

    return { options, points, expression: args.slice(i) };
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
            paths: findParts(args).points,
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
    const { words, pipesStderr } = wordsFrom(scan, element.start);
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
    const { words } = wordsFrom(scan, element.start);
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
    /** Ids of the `( … )` subshells around it in its unit. */
    subshells: number[];
}

interface Frame {
    kind: "group" | "if" | "loop" | "case";
    conds: number[];
    /** The current branch of an `if` or `case`, or the body of a loop after `do`. */
    branch: number | null;
    members: StatementInfo[];
    /** The id of a `( … )` group, which runs in a subshell. */
    subshell?: number;
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
        if (!SHELLS.has(simpleCommandWord(elements[k], scan.command))) {
            continue;
        }

        const { words } = wordsFrom(scan, elements[k].start);
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
                const subshell = token === "(" ? { subshell: nextId() } : {};
                stack.push({ kind: "group", conds: pending, branch: null, members: [], ...subshell });
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
                piped ? [] : wordsFrom(scan, statement.start).words,
                piped ? elements : elements.slice(1)
            );
        } else if (top && CLOSES.get(first) === top.kind) {
            stack.pop();
            wrap(top.members, wordsFrom(scan, statement.start).words.slice(1), elements.slice(1));
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
            subshells: stack.flatMap((f) => (f.subshell === undefined ? [] : [f.subshell])),
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
            const { out, err } = replayRedirects(wordsFrom(scan, statement.start).words.slice(1));
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
    const units: ShellUnit[] = splitSubstitutions(scan.cleaned, 0, scan.command).map((span, i) => ({
        span,
        end: span.start + span.text.length,
        capture: i > 0,
    }));

    for (const range of scan.executableRanges) {
        const backtick = scan.command[range.start - 1] === "`";
        const spans = splitSubstitutions(
            cleanedBody(scan.command, range),
            range.start,
            scan.command.slice(range.start, range.end)
        );

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
    const after = wordsFrom(scan, close === '"' || close === "'" ? body.end + 1 : body.end);
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

// A path that names the same file from any folder: absolute, or under the home folder.
const ANCHORED_PATH = /^(?:\/|~(?:\/|$)|\$HOME(?:\/|$)|\$\{HOME\}(?:\/|$))/;

// Whether two statements run in the same folder. Without the folder the command
// starts in, two statements that no `cd`, `pushd` or `popd` precedes both run there.
function sameFolder(scan: ShellScan, structure: readonly StatementInfo[], a: Span, b: Span): boolean {
    const folderA = folderAt(scan, a, structure);
    const folderB = folderAt(scan, b, structure);

    if (scan.cwd || folderA !== null || folderB !== null) {
        return folderA !== null && folderA === folderB;
    }

    const later = Math.max(a.start, b.start);
    return !structure.some((info) => info.span.start < later && MOVES.test(info.span.text));
}

// Whether every hit's producer is ls, du, stat, find or fd with flags and
// primaries that fail only on a path, and every path it names is named by
// another listing or search that runs whenever the producer runs, in the same
// folder for a relative path, and whose stderr reaches the terminal.
function everyHitCovered(scan: ShellScan, hits: readonly DevnullHit[]): boolean {
    const producers = hits.map((hit) => parseElement(scan, hit.producer));

    if (
        hits.some((hit, i) => {
            const p = producers[i];
            return (
                !p ||
                !COVERABLE_PRODUCERS.has(p.word) ||
                p.paths.length === 0 ||
                !producerFlagsSafe(p.word, wordsOf(scan, hit.producer).args)
            );
        })
    ) {
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

            if (own || !PATH_OPERANDS.has(simpleCommandWord(element, scan.command))) {
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
            witnesses.some((s) =>
                s.parsed.paths.some(
                    (named) =>
                        names(path, producer.lists, named, s.parsed.lists) &&
                        ((ANCHORED_PATH.test(path) && ANCHORED_PATH.test(named)) ||
                            sameFolder(scan, statements, hit.statement, s.info.span))
                )
            )
        );
    });
}

// A literal path in a folder under /tmp. /tmp itself holds other users' folders.
const SCRATCH_PATH = /^\/(?:private\/)?tmp\/[^/$`*?[{~][^$`*?[{~]*$/;

// Whether a listing of `path` fails only when it is missing, the honest 0. A
// folder under /tmp can belong to another user, refuse a listing by its mode,
// or be a link into a protected tree, so the path as it is now must be missing,
// or stay under /tmp once its links are followed and be readable (a folder
// searchable too). The folders under it are the scratch of the one who can read it.
function scratchListable(path: string): boolean {
    try {
        const real = realpathSync(path);
        accessSync(real, statSync(real).isDirectory() ? constants.R_OK | constants.X_OK : constants.F_OK);
        return SCRATCH_PATH.test(`${real}/`);
    } catch (err) {
        return err instanceof Error && "code" in err && err.code === "ENOENT";
    }
}

// A mistyped flag, primary or value also prints 0, and a find primary or fd flag
// can name a path outside /tmp or run a command, so each must be in a safe table.
function everyHitScratch(scan: ShellScan, hits: readonly DevnullHit[]): boolean {
    return hits.every((hit) => {
        const p = parseElement(scan, hit.producer);
        return (
            !!p &&
            COVERABLE_PRODUCERS.has(p.word) &&
            p.paths.length > 0 &&
            p.paths.every(
                (path) => SCRATCH_PATH.test(path) && !path.split("/").includes("..") && scratchListable(path)
            ) &&
            producerFlagsSafe(p.word, wordsOf(scan, hit.producer).args)
        );
    });
}

type CountedRoute = "block" | "covered" | "scratch";

// The counted hits, when they take `route`: the block and its context rules
// split one set of hits, so a command never gets two of them.
function countedMatch(scan: ShellScan, route: CountedRoute): ShellMatch | null {
    const hits = devnullHits(scan, (later) => later.some((e) => isCounter(scan, e)));

    if (hits.length === 0) {
        return null;
    }

    const taken = everyHitCovered(scan, hits) ? "covered" : everyHitScratch(scan, hits) ? "scratch" : "block";
    return taken === route ? matchFromHits(scan, hits, route === "block") : null;
}

// ---------------------------------------------------------------------------
// The read note's exceptions: an empty result that can only mean "none"
// ---------------------------------------------------------------------------

const HOME = homedir();
// A listing or a search can be refused in these trees (TCC, root only, another
// volume) and in a child of these folders.
const PROTECTED_TREES = [
    "/System",
    "/Library",
    "/private/var",
    "/var",
    "/Volumes",
    ...["Library", "Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"].map((d) => `${HOME}/${d}`),
].map((p) => p.toLowerCase());
const PROTECTED_FOLDERS = new Set(["/", "/users", HOME.toLowerCase()]);

// Whether `path` may sit where a listing is refused. An unknown path may. A
// glob counts from the folder its first wildcard sits in.
function isProtected(path: string | null): boolean {
    if (path === null) {
        return true;
    }

    const glob = path.search(/[*?[]/);
    const fixed = (glob === -1 ? path : path.slice(0, path.lastIndexOf("/", glob))) || "/";
    const p = normalize(fixed)
        .replace(/(.)\/+$/, "$1")
        .toLowerCase();
    return PROTECTED_FOLDERS.has(p) || PROTECTED_TREES.some((root) => p === root || p.startsWith(`${root}/`));
}

// A path as the shell reads it, against `folder`. Null when it holds an
// expansion the guard cannot know. A variable in `loopVars` runs over bare
// words with no `/`, so it names a child of the folder.
function resolvePath(arg: string, folder: string | null, loopVars: ReadonlySet<string> = new Set()): string | null {
    const path = arg
        .replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME)
        .replace(/^\$\{?(\w+)\}?(?=\/|$)/, (m, name: string) => (loopVars.has(name) ? "_" : m));

    if (/[$`~]/.test(path) || path === "-") {
        return null;
    }

    return isAbsolute(path) ? normalize(path) : folder === null ? null : resolve(folder, path);
}

// The command word, the words before it, its arguments, and where its stderr goes (`|&` included).
function wordsOf(scan: ShellScan, element: Span): { word: string; before: string[]; args: string[]; err: string } {
    const { words, pipesStderr } = wordsFrom(scan, element.start);
    const cmd = commandTokenIndex(words.map((text) => ({ text, start: 0 })));
    const own = cmd === -1 ? [] : words.slice(cmd + 1);
    const { args, err } = replayRedirects(pipesStderr ? [...own, "2>&1"] : own);
    return { word: cmd === -1 ? "" : commandWord(words[cmd]), before: words.slice(0, Math.max(cmd, 0)), args, err };
}

function subshellsOf(info: StatementInfo): number[] {
    return info.unit.host ? [...info.subshells, ...subshellsOf(info.unit.host)] : info.subshells;
}

const MOVES = /(?:^|[\s;&|({])(?:cd|pushd|popd)(?=[\s;&|)}]|$)/;

// The folder a statement runs in: scan.cwd, moved by each `cd` before it in the
// outer command and in its own unit. A `cd` in a `( … )` that closed before it
// changes nothing. The folder is unknown after a `cd` the guard cannot resolve,
// one that may not run when the statement runs, one in another substitution or
// body or in a pipeline, and after a pushd or popd.
function folderAt(scan: ShellScan, statement: Span, structure: readonly StatementInfo[]): string | null {
    const at = structure.find((s) => s.span.start === statement.start);

    if (!at) {
        return null;
    }

    const conds = new Set(allConds(at));
    const subshells = new Set(subshellsOf(at));
    let folder = scan.cwd ?? null;

    for (const info of structure) {
        if (info.span.start >= statement.start || !MOVES.test(info.span.text)) {
            continue;
        }

        const elements = splitPipeline(info.span);
        const moves = elements.map((e) => wordsOf(scan, e)).filter((w) => /^(?:cd|pushd|popd)$/.test(w.word));
        const outer = !info.unit.capture && !info.unit.body;

        if (moves.length === 0 || subshellsOf(info).some((id) => !subshells.has(id))) {
            continue;
        }

        if (
            (!outer && info.unit !== at.unit) ||
            elements.length > 1 ||
            moves[0].word !== "cd" ||
            allConds(info).some((cond) => !conds.has(cond))
        ) {
            return null;
        }

        folder = resolvePath(moves[0].args.find((a) => a === "-" || !a.startsWith("-")) ?? "~", folder);
    }

    return folder;
}

// Variables of a `for name in a b c` whose words are bare names, when `at` lies
// in that loop's body and nothing assigns the name in between.
function loopVars(scan: ShellScan, at: number): Set<string> {
    const vars = new Set<string>();

    for (const unit of scan.units) {
        const before = unit.filter((u) => u.start < at);

        before.forEach((s, i) => {
            const { words } = wordsFrom(scan, s.start);
            const name = words[1] ?? "";
            let depth = 1;

            if (
                words[0] !== "for" ||
                words[2] !== "in" ||
                words.length <= 3 ||
                !words.slice(3).every((w) => /^[\w.-]+$/.test(w) && w !== "." && w !== "..")
            ) {
                return;
            }

            for (const later of before.slice(i + 1)) {
                const first = tokenize(later).find((t) => !RESERVED_PREFIX.has(t.text))?.text ?? "";
                depth += OPENS.get(first) === "loop" ? 1 : first === "done" ? -1 : 0;

                if (depth === 0 || first.startsWith(`${name}=`)) {
                    return;
                }
            }

            vars.add(name);
        });
    }

    return vars;
}

interface KnownFlags extends ProgramFlags {
    /** Every short flag the command accepts. */
    letters: string;
    /** Every long flag the command accepts. */
    names: ReadonlySet<string>;
    /** Flags that can fail whatever their value (a regex engine the build may lack). */
    risky: ReadonlySet<string>;
    /** The values each value flag accepts for sure. A value flag missing here can always fail (a type, a file, an encoding). */
    values: ReadonlyMap<string, RegExp>;
}

const longFlags = (list: string) => new Set(list.split(" ").map((name) => `--${name}`));
const valueFlags = <T>(list: string, value: T) => list.split(" ").map((flag): [string, T] => [flag, value]);
const NUMBER = /^\d+$/;
const ANY_VALUE = /^/;
// A glob with no alternation, class or escape always parses.
const PLAIN_GLOB = /^[^{}[\]\\]*$/;
const RADIX = /^[dox]$/;

// The producers an exception may clear. A mistyped flag or a bad flag value
// fails on stderr alone, so a producer with either keeps the note.
const KNOWN_FLAGS: ReadonlyMap<string, KnownFlags> = new Map([
    [
        "ls",
        {
            short: "D",
            long: new Set(),
            letters: "@ABCFGHILOPRSTUWXabcdefghiklmnopqrstuvwxy1%,",
            names: longFlags("color directory"),
            risky: new Set(),
            values: new Map([
                ["-D", ANY_VALUE],
                ["--color", /^(?:always|auto|never)$/],
            ]),
        },
    ],
    [
        "du",
        {
            short: "BdIt",
            long: new Set(),
            letters: "AHLPBIacdghklmnstx",
            names: new Set(),
            risky: new Set(),
            values: new Map([
                ["-B", /^\d+[kmgtKMGT]?$/],
                ["-d", NUMBER],
                ["-I", ANY_VALUE],
                ["-t", /^-?\d+[kmgtpKMGTP]?$/],
            ]),
        },
    ],
    [
        "stat",
        {
            short: "ft",
            long: new Set(),
            letters: "FLnqflrsxt",
            names: new Set(),
            risky: new Set(),
            values: new Map(valueFlags("-f -t", ANY_VALUE)),
        },
    ],
    [
        "strings",
        {
            short: "nt",
            long: new Set(),
            letters: "aont",
            names: new Set(),
            risky: new Set(),
            values: new Map([
                ["-n", NUMBER],
                ["-t", RADIX],
            ]),
        },
    ],
    [
        "nm",
        {
            short: "t",
            long: new Set(),
            letters: "aABgjlmnopPrstuUx",
            names: new Set(),
            risky: new Set(),
            values: new Map([["-t", RADIX]]),
        },
    ],
    [
        "rg",
        {
            ...RG_FLAGS,
            letters: "0AaBbCcdEeFfgHhIijLlMmNnoPpqrSsTtUuVvwxz",
            names: longFlags(
                "after-context before-context context case-sensitive color colors column count count-matches files " +
                    "files-with-matches files-without-match fixed-strings follow glob iglob heading no-heading hidden " +
                    "ignore-case invert-match json line-number no-line-number max-count max-depth max-filesize " +
                    "max-columns max-columns-preview multiline multiline-dotall no-filename with-filename no-ignore " +
                    "no-ignore-vcs no-messages null only-matching passthru pretty quiet replace smart-case sort sortr " +
                    "text trim vimgrep word-regexp line-regexp binary search-zip unrestricted byte-offset no-config " +
                    "one-file-system include-zero stats encoding type type-not type-add pre engine pcre2 file regexp"
            ),
            risky: new Set(["-P", "--pcre2"]),
            values: new Map([
                ...valueFlags(
                    "-A -B -C -d -j -M -m --after-context --before-context --context --max-depth --threads " +
                        "--max-columns --max-count",
                    NUMBER
                ),
                ...valueFlags("-g --glob --iglob", PLAIN_GLOB),
                ...valueFlags("-e --regexp -r --replace", ANY_VALUE),
                ...valueFlags("--sort --sortr", /^(?:none|path|modified|accessed|created)$/),
                ["--color", /^(?:never|auto|always|ansi)$/],
                ["--max-filesize", /^\d+[KMG]?$/],
            ]),
        },
    ],
    [
        "grep",
        {
            ...GREP_FLAGS,
            letters: "AaBbCcDdEeFfGHhIiJLlMmnOopqRrSsUuVvwXxyZz",
            names: longFlags(
                "include exclude exclude-dir include-dir color colour recursive dereference-recursive ignore-case " +
                    "files-with-matches files-without-match count line-number regexp file fixed-strings extended-regexp " +
                    "basic-regexp invert-match word-regexp line-regexp only-matching null binary-files context " +
                    "after-context before-context max-count no-messages quiet silent text with-filename no-filename " +
                    "directories devices perl-regexp"
            ),
            risky: new Set(["-P", "--perl-regexp"]),
            values: new Map([
                ...valueFlags("-A -B -C -m --after-context --before-context --context --max-count", NUMBER),
                // grep's globs go to fnmatch, which rejects nothing.
                ...valueFlags("-e --regexp --include --exclude --exclude-dir --include-dir", ANY_VALUE),
                ...valueFlags("-d --directories", /^(?:read|skip|recurse)$/),
                ...valueFlags("-D --devices", /^(?:read|skip)$/),
                ...valueFlags("--color --colour", /^(?:never|always|auto)$/),
                ["--binary-files", /^(?:binary|text|without-match)$/],
            ]),
        },
    ],
]);

// Whether every flag is in the producer's table, none can fail whatever its
// value, and every value is one the flag accepts.
function flagsValid(known: KnownFlags, { flags, values }: Positionals): boolean {
    return (
        [...flags].every(
            (flag) =>
                !known.risky.has(flag) &&
                (flag.startsWith("--") ? known.names.has(flag) : known.letters.includes(flag[1]))
        ) && values.every(([flag, value]) => known.values.get(flag)?.test(value) ?? false)
    );
}

// A pattern no regex engine rejects: no group, class, repeat or interval, and a
// backslash only before `|`, `.`, `/` or `-`.
function literalPattern(pattern: string): boolean {
    return pattern !== "" && !/[()[\]{}*+?\\]/.test(pattern.replace(/\\[|./-]/g, ""));
}

// The scratch route's tables: a find primary or an fd flag that names another
// path, runs a command, or takes a value that can fail is not here. Checked
// against BSD find, the bfs that Claude Code runs as `find`, and fd 10.5. A
// number has at most 9 digits, and a date's year is one BSD find parses.
const DATE = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?$/;
const literalDate = {
    test(value: string): boolean {
        const [, y = "", m = "", d = ""] = DATE.exec(value) ?? [];
        const day = new Date(Date.UTC(+y, +m - 1, +d));
        return +y >= 1971 && +y <= 2038 && day.getUTCMonth() === +m - 1 && day.getUTCDate() === +d;
    },
};
const COUNT = /^\d{1,9}$/;
const SCRATCH_FIND: ReadonlyMap<string, Pick<RegExp, "test"> | null> = new Map<string, Pick<RegExp, "test"> | null>([
    ...valueFlags("-empty -print -print0 -prune -depth -d -quit -true -false -ls -xdev -mount -nogroup -nouser", null),
    ...valueFlags("-name -iname -path -ipath -wholename -iwholename -lname -ilname", ANY_VALUE),
    ...valueFlags("-maxdepth -mindepth", COUNT),
    ...valueFlags("-amin -Bmin -cmin -mmin -inum -links", /^[-+]?\d{1,9}$/),
    ...valueFlags("-atime -Btime -ctime -mtime", /^[-+]?(?:\d{1,9}|(?:\d{1,9}[smhdw])+)$/),
    ...valueFlags("-newerat -newerBt -newerct -newermt", literalDate),
    // BSD find refuses more than 2^63 bytes.
    ["-size", /^[-+]?(?:\d{1,9}[ckMG]?|\d{1,6}T|\d{1,3}P)$/],
    ["-type", /^[bcdflps](?:,[bcdflps])*$/],
    ["-perm", /^[-+]?[0-7]{1,4}$/],
]);
const FIND_BINARY = new Set(["-a", "-and", "-o", "-or"]);

// Every option and primary is in SCRATCH_FIND with a value it takes, and the
// expression is whole: no dangling operator, no empty or unclosed group.
function findSafe(args: readonly string[]): boolean {
    const { options, expression } = findParts(args);
    let depth = 0;
    // An operand is due at the start and after `(`, `!` or a binary operator.
    let due = true;

    for (let i = 0; i < expression.length; i++) {
        const arg = expression[i];
        const value = SCRATCH_FIND.get(arg);

        if (arg === "(" || arg === "!" || arg === "-not") {
            depth += arg === "(" ? 1 : 0;
            due = true;
        } else if (arg === ")" || FIND_BINARY.has(arg)) {
            if (due || (arg === ")" && --depth < 0)) {
                return false;
            }

            due = arg !== ")";
        } else if (
            value === undefined ||
            (value !== null && (++i === expression.length || !value.test(expression[i])))
        ) {
            return false;
        } else {
            due = false;
        }
    }

    // bfs refuses a cluster of d, s and x alone (`-dx`), but not one with H, L, P or E.
    return (
        options.every((option) => !option.includes("X") && (option.length === 2 || /[HLPE]/.test(option))) &&
        depth === 0 &&
        (!due || expression.length === 0)
    );
}

const SCRATCH_FD: KnownFlags = {
    ...FD_FLAGS,
    letters: "01EFHILSacdegijpstu",
    names: longFlags(
        "hidden no-ignore no-ignore-vcs no-ignore-parent no-require-git unrestricted case-sensitive ignore-case " +
            "glob regex fixed-strings absolute-path follow full-path print0 max-depth min-depth exact-depth exclude " +
            "prune type extension size color threads max-results show-errors"
    ),
    risky: new Set(),
    values: new Map([
        ...valueFlags("-d --max-depth --min-depth --exact-depth --max-results", COUNT),
        ...valueFlags("-j --threads", /^[1-9]\d{0,2}$/),
        ...valueFlags("-e --extension", ANY_VALUE),
        ...valueFlags("-E --exclude", PLAIN_GLOB),
        ...valueFlags(
            "-t --type",
            /^(?:[fdlspbcxe]|file|dir|directory|symlink|socket|pipe|block-device|char-device|executable|empty)$/
        ),
        ...valueFlags("-S --size", /^[-+]?\d{1,9}(?:[bkmgt]|[kmgt]i)$/i),
        ...valueFlags("-c --color", /^(?:auto|always|never)$/),
    ]),
};
// Flags fd refuses together, and -g with --regex, where the later one decides
// how the pattern parses.
const FD_CONFLICTS = [
    ["-F --fixed-strings", "-g --glob"],
    ["-g --glob", "--regex"],
    ["--exact-depth", "-d --max-depth --min-depth --prune"],
    ["--prune", "-S --size"],
].map((pair) => pair.map((names) => names.split(" ")));

// fd's pattern is a Rust regex, or a glob under -g, and a `/` in it fails
// without -p. A regex passes when it is literal once `.*` and `.+` are gone.
function fdSafe({ words, flags }: Positionals): boolean {
    const pattern = words[0] ?? "";
    const has = (...names: string[]) => names.some((name) => flags.has(name));

    if (FD_CONFLICTS.some(([a, b]) => has(...a) && has(...b)) || (pattern.includes("/") && !has("-p", "--full-path"))) {
        return false;
    }

    if (has("-F", "--fixed-strings")) {
        return true;
    }

    const core = pattern.replace(/\.[*+]/g, "");
    return has("-g", "--glob") ? PLAIN_GLOB.test(pattern) : core === "" || literalPattern(core);
}

// Whether a producer's flags, primaries and values are all in the safe tables:
// the covered and the scratch routes both trust a count that fails only on a path.
function producerFlagsSafe(word: string, args: readonly string[]): boolean {
    if (word === "find") {
        return findSafe(args);
    }

    const known = word === "fd" ? SCRATCH_FD : KNOWN_FLAGS.get(word);

    if (!known) {
        return false;
    }

    const given = positionals(args, known);
    return flagsValid(known, given) && (word !== "fd" || fdSafe(given));
}

// `$(rg -l x .)`, `$(fd …)`, `$(find …)`: paths that a lister just found.
function listsFiles(operand: string): boolean {
    const m = /^\$\(([\s\S]*)\)$/.exec(operand);

    if (!m) {
        return false;
    }

    const words = readWords(m[1], 0, m[1].length).words;
    const cmd = commandTokenIndex(words.map((text) => ({ text, start: 0 })));
    const word = cmd === -1 ? "" : commandWord(words[cmd]);
    const known = KNOWN_FLAGS.get(word);

    if (word === "fd" || word === "find") {
        return true;
    }

    if ((word !== "rg" && word !== "grep") || !known) {
        return false;
    }

    const { flags } = positionals(words.slice(cmd + 1), known);
    return flags.has("-l") || flags.has("--files-with-matches") || (word === "rg" && flags.has("--files"));
}

// A stage that parses all of stdin as JSON throws on an empty or cut input, on
// its own stderr. jq and yq accept an empty input in silence.
const CODE_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
    ["bun", ["-e", "--eval"]],
    ["node", ["-e", "--eval", "-p", "--print"]],
    ["deno", ["eval"]],
    ["python3", ["-c"]],
]);

// JSON.parse or json.load(s) applied straight to the whole of stdin, with no
// fallback (`|| "[]"`) that turns an empty input into valid JSON.
const PARSES_STDIN =
    /JSON\.parse\(\s*(?:await\s+Bun\.stdin\.text\(\)|(?:require\(\s*["'](?:node:)?fs["']\s*\)\.|\w+\.)?readFileSync\(\s*(?:0|["']\/dev\/stdin["'])\s*(?:,\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*)?\))\s*\)|json\.load\(\s*sys\.stdin\s*\)|json\.loads\(\s*sys\.stdin\.read\(\)\s*\)/;

// Whether element `k` of the statement parses all of stdin strictly and its
// parse error reaches the terminal. Code that can catch the error does not count.
function parsesStdin(scan: ShellScan, statement: Span, k: number, structure: () => StatementInfo[]): boolean {
    const elements = splitPipeline(statement);
    const { word, args, err } = wordsOf(scan, elements[k]);
    const at = args.findIndex((arg) => CODE_FLAGS.get(word)?.includes(arg));
    const code = at === -1 ? "" : (args[at + 1] ?? "");

    if (!PARSES_STDIN.test(code) || /\b(?:try|catch|except)\b/.test(code)) {
        return false;
    }

    const info = structure().find((s) => s.span.start === statement.start);
    return !!info && stderrShown(scan, info, elements, k, err);
}

/** A command of the call and the operands it names. */
interface Sibling {
    statement: Span;
    operands: string[];
    /** A `[ -d X ]` test, which prints nothing: it counts only when it gates the producer. */
    test: boolean;
    /** Whether it lists a folder operand, so it shows a refused listing. */
    lists: boolean;
}

const TESTS = new Set(["[", "[[", "test"]);
// Commands whose words are not paths they read.
const NAMES_NO_PATH = new Set(
    (
        "echo printf print true false : for select case export local declare typeset readonly set unset shift " +
        "return exit continue break sleep kill wait read done fi esac"
    ).split(" ")
);

// Every test of a path, and every command whose stderr reaches the terminal.
function siblingsOf(scan: ShellScan, structure: readonly StatementInfo[]): Sibling[] {
    const siblings: Sibling[] = [];

    for (const info of structure) {
        const statement = info.span;
        const elements = splitPipeline(statement);

        elements.forEach((element, k) => {
            const { word, before, args, err } = wordsOf(scan, element);

            if (word === "" || NAMES_NO_PATH.has(word) || before.some((w) => commandWord(w) === "xargs")) {
                return;
            }

            if (TESTS.has(word)) {
                const operands = args.filter((_, i) => /^-[edf]$/.test(args[i - 1] ?? ""));
                siblings.push({ statement, operands: args.includes("!") ? [] : operands, test: true, lists: false });
            } else if (stderrShown(scan, info, elements, k, err)) {
                const parsed = PATH_OPERANDS.get(word)?.(args);
                const operands = parsed?.paths ?? args.filter((a) => !a.startsWith("-"));
                siblings.push({ statement, operands, test: false, lists: !!parsed?.lists });
            }
        });
    }

    return siblings;
}

// Whether the test statement must pass for the statement at `at` to run:
// `[ -d X ] || continue` before it, `[ -d X ] && …` chained into it, or
// `if [ -d X ]; then` around it.
function gates(scan: ShellScan, test: Span, at: number): boolean {
    if (test.start >= at) {
        return false;
    }

    const after = scan.cleaned.slice(test.start + test.text.length);
    const between = after.slice(0, at - test.start - test.text.length);

    return (
        (/^\s*\|\|\s*(?:continue|break|exit|return)\b/.test(between) && !/\bdone\b/.test(between)) ||
        (/^\s*&&/.test(between) && !/[;\n]|\|\|/.test(between)) ||
        (/^if\s/.test(test.text) && /^[\s;]*then\s/.test(after) && !/\b(?:fi|elif|else)\b/.test(between))
    );
}

// Whether an empty output of the hit's producer can only mean "none": a strict
// JSON parser downstream shows a failure, or the producer cannot fail unseen.
// An `ls -d` or a listing of several operands in a known folder shows which
// operands are missing; a fixed-pattern search over the folder cannot fail; and
// an operand that another command of the call creates, tests or reads with
// stderr visible is known to be there.
function emptyMeansNone(
    scan: ShellScan,
    hit: DevnullHit,
    structure: () => StatementInfo[],
    siblings: () => Sibling[]
): boolean {
    const elements = splitPipeline(hit.statement);
    const k = elements.findIndex((e) => e.start === hit.producer.start);
    const later = laterElements(elements, k).length;

    for (let j = k + 1; j <= k + later; j++) {
        if (parsesStdin(scan, hit.statement, j, structure)) {
            return true;
        }
    }

    const { word, args } = wordsOf(scan, hit.producer);
    const known = KNOWN_FLAGS.get(word);

    if (!known) {
        return false;
    }

    const given = positionals(args, known);
    const { words, flags } = given;
    const search = word === "rg" || word === "grep";
    const fixed = flags.has("-F") || flags.has("--fixed-strings") || flags.has("--files");
    const byFlag = flags.has("-e") || flags.has("--regexp");

    if (!flagsValid(known, given) || (search && !fixed && (byFlag || !literalPattern(words[0] ?? "")))) {
        return false;
    }

    const parsed = PATH_OPERANDS.get(word)?.(args);
    const paths = parsed?.paths ?? words;
    const folder = folderAt(scan, hit.statement, structure());
    // `.` cannot be missing; a folder is an error only to a grep without -r, strings or nm.
    const here = (path: string) =>
        (path === "." || path === "./") && !isProtected(folder) && !!parsed && (word !== "grep" || parsed.lists);
    let vars: Set<string> | undefined;
    const outside = (path: string) => {
        vars ??= loopVars(scan, hit.statement.start);
        return !isProtected(resolvePath(path, folder, vars));
    };

    if (word === "ls" && (flags.has("-d") || flags.has("--directory") || paths.length > 1)) {
        if (!isProtected(folder) && paths.every(outside)) {
            return true;
        }
    }

    // rg with no path searches the folder; a grep with no path reads stdin, or the folder under -r.
    const searchesFolder = word === "rg" || (word === "grep" && !!parsed?.lists && paths.length > 0);

    if (searchesFolder && !isProtected(folder) && paths.every((path) => here(path) || listsFiles(path))) {
        return true;
    }

    const operands = word === "rg" && paths.length === 0 ? ["."] : paths;
    const same = (a: string, b: string) => a.replace(/(.)\/+$/, "$1") === b.replace(/(.)\/+$/, "$1");
    // A test, cd, stat or mkdir succeeds on a folder whose listing is refused, so
    // for a listing it counts only outside the protected roots.
    const witness = (s: Sibling, operand: string) => !parsed?.lists || s.lists || outside(operand);

    return (
        operands.length > 0 &&
        operands.every(
            (operand) =>
                here(operand) ||
                siblings().some(
                    (s) =>
                        s.statement.start !== hit.statement.start &&
                        s.operands.some((named) => same(named, operand)) &&
                        (!s.test || gates(scan, s.statement, hit.statement.start)) &&
                        witness(s, operand)
                )
        )
    );
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
        '   # a path that may be absent: [ -d "$p" ] && ls "$p" | wc -l || echo "absent: $p"' +
        '   # tsc and tsgo print their errors on stdout, where the count drops them: { tsgo …; echo "tsgo rc=$?" >&2; } | rg -c x',
    evidence:
        "932 calls in 90 days, 45 sampled, none where the redirect was needed. CLAUDE.md records three " +
        "wrong conclusions on separate days, including `ls ~/Downloads/*.har 2>/dev/null | wc -l` printing " +
        "0 while eight files existed (macOS TCC had refused the listing).",
    detect(scan) {
        return countedMatch(scan, "block");
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
        return countedMatch(scan, "covered");
    },
};

export const stderrDiscardedThenCountedScratch: ShellRule = {
    id: "stderr-discarded-then-counted-scratch",
    kind: "misread",
    title: "2>/dev/null then a count of a literal path under /tmp",
    severity: "context",
    why:
        "stderr is discarded before the count, so a failure reads as 0 (or as a blank from `rg -c`). Every " +
        "counted path is a literal path under /tmp, where nothing refuses a listing, so the only failure left is " +
        "a missing path, and a missing path is the honest 0. A mistyped path reads as 0 too: check it before " +
        "you trust a 0.",
    wrong: "ls /tmp/cc/x/out 2>/dev/null | wc -l",
    right: "ls /tmp/cc/x/out | wc -l",
    evidence:
        "The 2026-11-01 audit of the guard log: six counted blocks counted a literal path the user owns, and both " +
        "judges rated each block maybe-incorrect because a missing path was the true 0. Under the home folder an " +
        "Apple data store can refuse a listing, and the list of such stores is open-ended, so only /tmp is exempt.",
    detect(scan) {
        return countedMatch(scan, "scratch");
    },
};

export const ddSkipSilentShortRead: ShellRule = {
    id: "dd-skip-silent-short-read",
    kind: "misread",
    title: "dd skip= with status=none, then a count: an offset past the end counts as 0",
    severity: "context",
    why:
        "dd reports a read past end of file only on stderr (0+0 records in), and status=none hides that line, " +
        "so an offset past the end counts as 0; compare skip x bs with the file size first. status=none still " +
        "shows a real error, such as a missing input file.",
    wrong: "dd if=f.log bs=1048576 skip=2700 count=1 status=none | LC_ALL=C tr -d '\\000' | wc -c",
    right: "stat -f %z f.log; dd if=f.log bs=1048576 skip=2700 count=1 | LC_ALL=C tr -d '\\000' | wc -c",
    evidence:
        "The 2026-11-01 audit of the guard log: after a correct block of `dd … skip=$off 2>/dev/null | … | wc -c`, " +
        "the agent switched to status=none and printed the same false zeros for offsets past the end of a 2585 MiB " +
        "file. A skip past the end exits 0, writes nothing and says 0+0 records in on stderr only.",
    detect(scan) {
        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("status=none")) {
                    continue;
                }

                const elements = splitPipeline(statement);

                for (let k = 0; k + 1 < elements.length; k++) {
                    const words = tokenize(elements[k]).map((t) => t.text);

                    if (
                        simpleCommandWord(elements[k], scan.command) === "dd" &&
                        words.includes("status=none") &&
                        words.some((w) => /^(?:skip|iseek)=/.test(w)) &&
                        laterElements(elements, k).some((e) => isCounter(scan, e))
                    ) {
                        const matched = originalSlice(scan, statement.start, statement.start + statement.text.length);
                        return { matched, index: statement.start };
                    }
                }
            }
        }

        return null;
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
        let structure: StatementInfo[] | undefined;
        let siblings: Sibling[] | undefined;
        const statements = () => {
            structure ??= callStructure(scan);
            return structure;
        };
        const known = () => {
            siblings ??= siblingsOf(scan, statements());
            return siblings;
        };
        const hits = devnullHits(
            scan,
            (later) => !later.some((e) => isCounter(scan, e)) && later.some((e) => isReader(e.text))
        ).filter((hit) => !emptyMeansNone(scan, hit, statements, known));

        return hits.length > 0 ? matchFromHits(scan, hits) : null;
    },
};

export const devnullRules: readonly ShellRule[] = [
    stderrDiscardedThenCounted,
    stderrDiscardedThenCountedCovered,
    stderrDiscardedThenCountedScratch,
    ddSkipSilentShortRead,
    stderrDiscardedThenRead,
];
