// zsh facts the Bash tool cannot infer: it runs zsh 5.9 with NO_BARE_GLOB_QUAL
// set, `log` is a zsh builtin that shadows /usr/bin/log, and an unquoted
// parameter expansion is never split into words (SH_WORD_SPLIT is off).

import {
    commandTokenIndex,
    commandWord,
    originalSlice,
    RESERVED_PREFIX,
    type ShellScan,
    type Span,
    splitPipeline,
    splitStatements,
    splitSubstitutions,
    stripShellNoise,
    tokenize,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

export const zshGlobQualifier: ShellRule = {
    id: "zsh-glob-qualifier",
    kind: "misread",
    title: "(N) / (#q…) glob qualifiers fail here: NO_BARE_GLOB_QUAL is set",
    severity: "block",
    why:
        'Claude Code sets NO_BARE_GLOB_QUAL on every Bash call, so `ls *.log(N)` does not mean "empty ' +
        'list when nothing matches"; it fails with the very `no matches found` error the qualifier was ' +
        'meant to avoid, and the failure reads as "there are no files".',
    wrong: "ls *.log(N)",
    right: "[ -e app.log ] && ls *.log   # or: ( setopt NULL_GLOB; ls -d *.log )",
    evidence: "0 uses in 30 days; CLAUDE.md lists it under zsh facts because it is the idiom a model reaches for.",
    detect(scan): ShellMatch | null {
        // Glued to the word before it, so `$(N)`, `<(N)` and `; (N)` are not globs.
        const m = /(?<![$<>\s])\((N|#q[^)\s]*)\)(?=\s|$|[;&|)])/.exec(scan.cleaned);

        if (!m) {
            return null;
        }

        return { matched: scan.command.slice(m.index, m.index + m[0].length), index: m.index };
    },
};

export const bareLogCommand: ShellRule = {
    id: "bare-log-command",
    kind: "misread",
    title: "bare `log show` runs the zsh builtin, not /usr/bin/log",
    severity: "block",
    why:
        "`log` is a zsh builtin (it lists logged-in users) and shadows /usr/bin/log. `log show --predicate …` " +
        'answers `too many arguments`, which looks like "no matching events" when the output is skimmed. ' +
        "`command log` bypasses the builtin.",
    wrong: "log show --last 5m --predicate 'process == \"sharingd\"'",
    right: "command log show --last 5m --predicate 'process == \"sharingd\"'",
    evidence: "223 `log show/stream` calls in 30 days; 200 already used `command log`, the rest hit the builtin.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("log")) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens, scan.command);

                    if (cmd === -1 || tokens[cmd].text !== "log") {
                        continue;
                    }

                    // commandTokenIndex skipped the wrappers. Every wrapper except
                    // `builtin` (and `time`, a reserved word) execs the real binary, so
                    // `command log`, `sudo log`, `env log`, `exec log` all bypass the
                    // builtin; only a bare `log` or `builtin log` hits it. The reserved words
                    // commandTokenIndex also skips (`do`, `then`, `!` …) run nothing themselves,
                    // so `for f in a; do log show …; done` still reaches the builtin.
                    if (
                        tokens
                            .slice(0, cmd)
                            .some(
                                (t) =>
                                    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text) &&
                                    !RESERVED_PREFIX.has(t.text) &&
                                    !["builtin", "time"].includes(commandWord(t.text))
                            )
                    ) {
                        continue;
                    }

                    const sub = tokens[cmd + 1]?.text;

                    if (sub !== "show" && sub !== "stream" && sub !== "collect" && sub !== "config") {
                        continue;
                    }

                    const start = tokens[cmd].start;
                    const matched = originalSlice(scan, start, element.start + element.text.length);
                    const suggestion = `${scan.command.slice(0, start)}command ${scan.command.slice(start)}`;

                    return { matched, index: start, suggestion };
                }
            }
        }

        return null;
    },
};

// --- zsh-word-split ---------------------------------------------------------
//
// bash splits an unquoted `$files` on IFS; zsh does not (SH_WORD_SPLIT is off), so
// `for f in $files` runs once with the whole list as one value. An unquoted `$( … )`
// IS split in zsh, only a parameter expansion is not. The rule fires only when the
// same command assigned the variable from something that is a list by construction,
// because `sha=$(git rev-parse HEAD); git show $sha` is correct zsh and must pass.
//
// A search (`f=$(rg -l 'class Foo' app); sed -n 1,80p $f`) fires only inside a `for`
// loop. As an argument it nearly always finds the one file the command expects, which
// zsh passes correctly: 58 of 74 hits in a 40,000-command replay on 2026-11-02 were that
// idiom, while every `for` loop hit was the bug.

/**
 * What an assignment put into a variable, as far as splitting goes. `list`: several lines by
 * construction and meant as several (`git diff --name-only`, `head -40`, `seq`, a jq `.[]`).
 * `search`: the result of looking something up (`rg -l`, `fd`, `find`, `ls`, `pgrep`), often
 * the one hit the command expects. `unknown`: a command substitution the tables below cannot
 * place. `single`: one value by construction (`git rev-parse`, `wc -l`, `head -1`). `words`: a
 * quoted literal with whitespace inside. `array`: `x=( … )`, which zsh iterates per element.
 * `scalar`: anything else (`x=foo`, `x=$y`, a quoted path or sentence).
 */
type ValueKind = "list" | "search" | "unknown" | "single" | "words" | "array" | "scalar";
type OutputShape = "list" | "search" | "single" | "unknown";
/** `pass`: a filter that keeps its input's shape. `narrow`: a grep filter, which turns a list into a search. */
type ElementVerdict = OutputShape | "pass" | "narrow";
/** `(f)` splits on newlines (command output), `=` on IFS (a literal, or output joined by spaces). */
type SplitFlag = "(f)" | "=";

interface AssignedValue {
    kind: ValueKind;
    flag: SplitFlag;
    /** Offset just past the value in the original command. */
    end: number;
}

interface Range {
    start: number;
    end: number;
}

interface Assignment extends AssignedValue {
    name: string;
    start: number;
    /** The subshell it was made in: zsh keeps it from every use outside that range. */
    scope: Range;
    /** Made by `export` or `typeset -x`: a fresh zsh started after it sees the variable too. */
    exported: boolean;
}

interface ParameterUse {
    name: string;
    start: number;
    end: number;
    /** An item of a `for … in` list, and whether it is the only item. */
    loop: boolean;
    soleItem: boolean;
    /** The token before it is an option (`-m $msg`, `--title $title`): a value meant as one string. */
    optionValue: boolean;
}

const SCALAR_FLAG: SplitFlag = "=";
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const ARRAY_ASSIGNMENT = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)\+?=\(/g;
const ANY_ASSIGNMENT = /(^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*\+?=/m;
const PARAMETER = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const REDIRECT = /^(\d*(<|>|>>|>\||<>|>&|<&)|&>|&>>|<<<)$/;
// The command turned splitting on itself, or switched to sh semantics. Matched in code only.
const SPLIT_ENABLED = /\b(setopt|set\s+-o)\s[^;\n]*\bsh_?word_?split\b|\bemulate\s+(-\S+\s+)*(sh|ksh|bash)\b/gi;
// The opening line of a heredoc fed to a shell (`bash <<'EOF'`, `sudo zsh -s <<EOF`). The
// scanner reads that body as code. bash and sh split it; zsh runs it in a fresh child shell.
// Groups: 2 the shell, 3 the operator, 4 the `-` that strips tabs, 6 the delimiter.
const SHELL_HEREDOC =
    /(^|[\s;&|(])(bash|sh|zsh|dash|ksh)(?:\s(?:[^\n<]|<(?!<))*)?(<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\5)/gm;
// A zsh command line that starts its shell with splitting on: `zsh -y`, `zsh -fy`. The letter is
// case-sensitive (`-Y` is another option); the names below are not, and ignore `_` and `-`.
const ZSH_SPLIT_LETTER = /\s-[A-Za-z]*y(?=\s|$)/;
const ZSH_SPLIT_NAME = /\s(?:-o\s*|--)sh[-_]?word[-_]?split(?=\s|$)|\s--emulate\s+(?:sh|ksh|bash)(?=\s|$)/i;
// `$name` and a `${…}` without quotes inside; marked to tell code from a double-quoted span.
const EXPANSION_MARK = /\$(?=[A-Za-z_]|\{[^}"'`]*\})/g;
const MARK = "\u0001";

const DECLARATIONS = new Set(["local", "typeset", "declare", "export", "readonly", "integer", "float"]);
// An argument these take is one string by intent, or prints the same split or not.
const ONE_STRING_COMMANDS = new Set([
    ...DECLARATIONS,
    "echo",
    "print",
    "printf",
    "[",
    "[[",
    "test",
    "case",
    "eval",
    "cd",
    "pushd",
    "source",
    ".",
    "let",
    "read",
    "set",
    "exit",
    "return",
    "shift",
    "unset",
    ":",
    "trap",
    "alias",
    "ssh",
    "watch",
]);
const SINGLE_OUTPUT = new Set([
    "wc",
    "basename",
    "dirname",
    "pwd",
    "date",
    "mktemp",
    "realpath",
    "readlink",
    "which",
    "whoami",
    "hostname",
    "uname",
    "id",
    "expr",
    "bc",
    "shasum",
    "md5",
    "md5sum",
    "sha1sum",
    "sha256sum",
    "nproc",
    "tty",
    "logname",
]);
const LIST_OUTPUT = new Set(["seq", "jot", "comm"]);
const SEARCH_OUTPUT = new Set(["ls", "find", "fd", "fdfind", "locate", "mdfind", "pgrep"]);
const LINE_FILTERS = new Set(["gawk", "cut", "tee", "rev", "tac", "column", "cat"]);
const SORTERS = new Set(["sort", "uniq"]);
const GREPS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ugrep", "ack"]);
const JSON_QUERIES = new Set(["jq", "yq", "gojq", "gh"]);
const GIT_SINGLE = new Set([
    "rev-parse",
    "merge-base",
    "symbolic-ref",
    "describe",
    "config",
    "hash-object",
    "write-tree",
    "commit-tree",
]);
const GIT_LIST = new Set(["for-each-ref", "cherry", "worktree", "stash", "tag", "ls-remote"]);
const GIT_SEARCH = new Set(["ls-files", "ls-tree"]);

function matchParen(cleaned: string, open: number): number {
    let depth = 0;

    for (let i = open; i < cleaned.length; i++) {
        if (cleaned[i] === "(") {
            depth++;
        } else if (cleaned[i] === ")") {
            depth--;

            if (depth === 0) {
                return i;
            }
        }
    }

    return cleaned.length;
}

// `-N`, `-n N`, `-nN`, `--lines=N`, `--max-count=N`: the explicit line count, or null.
function explicitCount(args: string[], long: string): string | null {
    for (let i = 0; i < args.length; i++) {
        const glued = new RegExp(`^(?:-n|--${long}=|-)(\\+?\\d+)$`).exec(args[i]);

        if (glued) {
            return glued[1];
        }

        if ((args[i] === "-n" || args[i] === `--${long}`) && /^\+?\d+$/.test(args[i + 1] ?? "")) {
            return args[i + 1];
        }
    }

    return null;
}

// An explicit count of 2 or more says the command expects several lines.
function countedOutput(count: string | null, uncounted: ElementVerdict): ElementVerdict {
    if (count === null) {
        return uncounted;
    }

    return count === "1" ? "single" : "list";
}

function headTailOutput(args: string[]): ElementVerdict {
    if (args.some((arg) => arg === "-f" || arg === "-F" || arg === "--follow")) {
        return "unknown";
    }

    if (args.some((arg) => arg.startsWith("-c") || arg.startsWith("--bytes"))) {
        return "single";
    }

    return countedOutput(explicitCount(args, "lines"), "pass");
}

function gitOutput(args: string[]): ElementVerdict {
    let i = 0;

    while (i < args.length && args[i].startsWith("-")) {
        i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
    }

    const sub = args[i] ?? "";
    const rest = args.slice(i + 1);
    const count = explicitCount(rest, "max-count");

    if (rest.includes("--name-only") || rest.includes("--name-status")) {
        return "list";
    }

    if (GIT_SINGLE.has(sub)) {
        return "single";
    }

    if (GIT_LIST.has(sub)) {
        return "list";
    }

    if (GIT_SEARCH.has(sub)) {
        return "search";
    }

    if (sub === "branch") {
        return rest.includes("--show-current") ? "single" : "list";
    }

    if (sub === "rev-list" && rest.includes("--count")) {
        return "single";
    }

    // `git log --diff-filter=A -- f` usually names the one commit the command wants.
    if (sub === "log" || sub === "rev-list") {
        return countedOutput(count, "search");
    }

    if (sub === "show") {
        return count === "1" || rest.includes("-s") || rest.includes("--no-patch") ? "single" : "unknown";
    }

    if (sub === "status") {
        const short = rest.some((arg) => arg.startsWith("--porcelain") || arg === "--short" || arg === "-s");
        return short ? "list" : "unknown";
    }

    if (sub === "remote") {
        if (rest[0] === "get-url") {
            return "single";
        }

        return rest.length === 0 || rest[0] === "-v" ? "list" : "unknown";
    }

    return "unknown";
}

function grepOutput(args: string[], hasPrevious: boolean): ElementVerdict {
    const shortFlag = (letter: string) => args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
    const longFlag = (...names: string[]) => args.some((arg) => names.includes(arg));
    const oneMatch = args.some(
        (arg, j) =>
            arg === "-m1" || arg === "--max-count=1" || ((arg === "-m" || arg === "--max-count") && args[j + 1] === "1")
    );

    if (shortFlag("c") || shortFlag("q") || longFlag("--count", "--count-matches", "--quiet") || oneMatch) {
        return "single";
    }

    if (shortFlag("o") || longFlag("--only-matching")) {
        return hasPrevious ? "pass" : "search";
    }

    if (shortFlag("l") || longFlag("--files", "--files-with-matches")) {
        return "search";
    }

    return hasPrevious ? "narrow" : "unknown";
}

// `tr '\n' ' '` joins the lines into one space-separated line, still a list; `tr '\n' ','`
// and `tr -d '\n'` make one string; any other `tr` maps characters and keeps the lines.
function trOutput(raw: string): ElementVerdict {
    const m =
        /\btr\s+((?:-[A-Za-z]+\s+)*)(?:'([^']*)'|"([^"]*)"|(\S+))(?:\s+(?:'([^']*)'|"([^"]*)"|([^\s|;&)]+)))?/.exec(
            raw
        );

    if (!m) {
        return "pass";
    }

    const from = m[2] ?? m[3] ?? m[4] ?? "";
    const to = m[5] ?? m[6] ?? m[7];

    if (!from.includes("\\n")) {
        return "pass";
    }

    if (m[1].includes("d") || to === undefined) {
        return "single";
    }

    return /^\s+$/.test(to) ? "list" : "single";
}

// One pipeline element of a substitution body.
function elementOutput(element: Span, raw: string, hasPrevious: boolean): ElementVerdict {
    const tokens = tokenize(element);
    const cmd = commandTokenIndex(tokens);
    const xargs = tokens.findIndex((t) => commandWord(t.text) === "xargs");

    if (xargs !== -1 && (cmd === -1 || xargs < cmd)) {
        return hasPrevious ? "pass" : "unknown";
    }

    if (cmd === -1) {
        return "unknown";
    }

    const word = commandWord(tokens[cmd].text);
    const args = tokens.slice(cmd + 1).map((t) => t.text);

    if (word === "head" || word === "tail") {
        return headTailOutput(args);
    }

    if (word === "git") {
        return gitOutput(args);
    }

    if (GREPS.has(word)) {
        return grepOutput(args, hasPrevious);
    }

    if (word === "tr") {
        return trOutput(raw);
    }

    if (word === "sed" || word === "gsed") {
        // `sed -n '3p'` picks lines; any other sed rewrites them one by one.
        return args.some((arg) => /^-[A-Za-z]*n/.test(arg)) ? "unknown" : "pass";
    }

    if (word === "awk") {
        return /\bNR\s*==|\bEND\b|\bexit\b/.test(raw) ? "unknown" : "pass";
    }

    if (SINGLE_OUTPUT.has(word)) {
        return "single";
    }

    if (LIST_OUTPUT.has(word)) {
        return "list";
    }

    if (SEARCH_OUTPUT.has(word) || (word === "lsof" && args.some((arg) => /^-[A-Za-z]*t/.test(arg)))) {
        return "search";
    }

    if (SORTERS.has(word)) {
        return hasPrevious ? "pass" : "list";
    }

    if (LINE_FILTERS.has(word)) {
        return hasPrevious ? "pass" : "unknown";
    }

    // `jq -r '.[].name'`, `gh pr list --json number -q '.[].number'`: one line per element. With
    // a `select(…)` or an index it is a lookup, as in `--jq '.jobs[]|select(.name=="test")|.id'`.
    if (JSON_QUERIES.has(word) && raw.includes("[]")) {
        return /\bselect\(|\[\d+\]/.test(raw) ? "search" : "list";
    }

    return "unknown";
}

// `tr '\n' ' '` and a bare `xargs` put every line on one, separated by spaces. Any other
// `tr` maps characters and keeps the lines.
function joinsLines(element: Span, raw: string): boolean {
    const tokens = tokenize(element);
    const cmd = commandTokenIndex(tokens);

    if (cmd === -1) {
        return tokens.some((t) => commandWord(t.text) === "xargs");
    }

    return commandWord(tokens[cmd].text) === "tr" && trOutput(raw) === "list";
}

// The output shape of the last statement of a `$( … )` body, read from its last pipeline
// element back to the first one that decides it.
function substitutionValue(body: string, end: number): AssignedValue {
    const outer = splitSubstitutions(stripShellNoise(body))[0];
    const statements = outer ? splitStatements(outer) : [];
    const last = statements[statements.length - 1];

    if (!last) {
        return { kind: "unknown", flag: "=", end };
    }

    const elements = splitPipeline(last);
    let shape: OutputShape = "unknown";
    let narrowed = false;
    let joined = false;

    for (let i = elements.length - 1; i >= 0; i--) {
        const raw = body.slice(elements[i].start, elements[i + 1]?.start ?? body.length);
        const verdict = elementOutput(elements[i], raw, i > 0);
        joined ||= joinsLines(elements[i], raw);

        if (verdict === "narrow") {
            narrowed = true;
            continue;
        }

        if (verdict !== "pass") {
            shape = verdict;
            break;
        }
    }

    if (narrowed && shape === "list") {
        shape = "search";
    }

    // Lines split per line, so a path with a space survives. Lines that an element at or after
    // the deciding one joined, and anything unplaced, split on IFS: what bash would have done.
    const flag: SplitFlag = (shape === "list" || shape === "search") && !joined ? "(f)" : "=";

    return { kind: shape, flag, end };
}

// A quoted value that reads as one string even with a space in it: a path with a space,
// or a sentence (`"fix: the thing"`, `"Done. Next"`).
function readsAsOneString(text: string): boolean {
    const words = text.trim().split(/\s+/);

    if (/^[/~]/.test(words[0]) && words.slice(1).some((word) => !/^([/~$]|\.\/)/.test(word))) {
        return true;
    }

    return /[,.;:!?](\s|$)/.test(text);
}

function literalValue(text: string, end: number): AssignedValue {
    if (!/\S\s+\S/.test(text) || readsAsOneString(text)) {
        return { kind: "scalar", flag: SCALAR_FLAG, end };
    }

    return { kind: "words", flag: "=", end };
}

function doubleQuotedValue(command: string, cleaned: string, at: number): AssignedValue {
    const subs: Array<{ start: number; end: number }> = [];
    let outside = "";
    let i = at + 1;

    while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\") {
            outside += "x";
            i += 2;
            continue;
        }

        if (command.startsWith("$(", i) && !command.startsWith("$((", i)) {
            const close = matchParen(cleaned, i + 1);
            subs.push({ start: i + 2, end: close });
            outside += MARK;
            i = close + 1;
            continue;
        }

        outside += command[i];
        i++;
    }

    const end = Math.min(i + 1, command.length);

    if (subs.length === 1 && outside.trim() === MARK) {
        return substitutionValue(command.slice(subs[0].start, subs[0].end), end);
    }

    return literalValue(outside.replaceAll(MARK, "x"), end);
}

// The value of `name=` starting at `at` in the original command.
function assignedValue(command: string, cleaned: string, at: number): AssignedValue {
    const ch = command[at];

    if (ch === "(") {
        return { kind: "array", flag: SCALAR_FLAG, end: matchParen(cleaned, at) + 1 };
    }

    if (command.startsWith("$((", at)) {
        return { kind: "scalar", flag: SCALAR_FLAG, end: matchParen(cleaned, at + 1) + 1 };
    }

    if (command.startsWith("$(", at)) {
        const close = matchParen(cleaned, at + 1);
        return substitutionValue(command.slice(at + 2, close), close + 1);
    }

    if (ch === "`") {
        const close = command.indexOf("`", at + 1);
        const end = close === -1 ? command.length : close;
        return substitutionValue(command.slice(at + 1, end), end + 1);
    }

    if (ch === '"') {
        return doubleQuotedValue(command, cleaned, at);
    }

    if (ch === "'" || command.startsWith("$'", at)) {
        const open = ch === "'" ? at : at + 1;
        const close = command.indexOf("'", open + 1);
        const end = close === -1 ? command.length : close;
        const text = command.slice(open + 1, end);
        return literalValue(ch === "'" ? text : text.replace(/\\[nt]/g, " "), end + 1);
    }

    const word = /^[^\s;&|()<>]*/.exec(command.slice(at));
    return { kind: "scalar", flag: SCALAR_FLAG, end: at + (word?.[0].length ?? 0) };
}

function blankRange(text: string, start: number, end: number): string {
    return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
}

interface HeredocBody extends Range {
    /**
     * A fresh zsh reads the body as written, with splitting off. Not so for bash or sh, for a
     * zsh started with `-y` or `-o shwordsplit`, or for an unquoted delimiter (`zsh <<EOF`),
     * where the outer shell expands every `$x` into the text before the child parses it.
     */
    zsh: boolean;
}

// The body of each heredoc fed to a shell: from the line after its operator to its terminator.
function shellHeredocBodies(command: string, cleaned: string): HeredocBody[] {
    const bodies: HeredocBody[] = [];

    for (const m of command.matchAll(SHELL_HEREDOC)) {
        const word = m.index + m[1].length;
        const op = m.index + m[0].length - m[3].length;
        const open = command.indexOf("\n", op);

        // The shell word and the operator are code, not text inside quotes or a comment.
        if (
            open === -1 ||
            !cleaned.startsWith(m[2], word) ||
            !stripShellNoise(`${command.slice(word, op)}x`).endsWith("x")
        ) {
            continue;
        }

        let end = command.length;
        let line = open + 1;

        while (line < command.length) {
            const next = command.indexOf("\n", line);
            const lineEnd = next === -1 ? command.length : next;
            const text = command.slice(line, lineEnd);

            if ((m[4] === "-" ? text.replace(/^\t+/, "") : text) === m[6]) {
                end = line;
                break;
            }

            line = lineEnd + 1;
        }

        const options = command.slice(word + m[2].length, op);
        const zsh = m[2] === "zsh" && m[5] !== "" && !ZSH_SPLIT_LETTER.test(options) && !ZSH_SPLIT_NAME.test(options);
        bodies.push({ start: open + 1, end, zsh });
    }

    return bodies;
}

// Each `( … )` pair: a subshell, or a `$( … )` or `<( … )` body. The other pairs (an array
// body, `$(( … ))`, a glob qualifier) hold no assignment this rule records.
function parenRanges(cleaned: string): Range[] {
    const ranges: Range[] = [];
    const open: number[] = [];

    for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === "(") {
            open.push(i);
        } else if (cleaned[i] === ")") {
            const start = open.pop();

            if (start !== undefined) {
                ranges.push({ start, end: i });
            }
        }
    }

    return [...ranges, ...open.map((start) => ({ start, end: cleaned.length }))];
}

function within(scope: Range, at: number): boolean {
    return scope.start <= at && at < scope.end;
}

interface WordSplitHit {
    use: ParameterUse;
    flag: SplitFlag;
}

function wordSplitHits(scan: ShellScan): WordSplitHit[] {
    const { command } = scan;

    if (!ANY_ASSIGNMENT.test(scan.cleaned)) {
        return [];
    }

    // A body that splits, or that the outer shell expands first, is dropped (see HeredocBody).
    // A body a fresh zsh reads as written is checked as the separate shell it is.
    const heredocs = shellHeredocBodies(command, scan.cleaned);
    const fresh = heredocs.filter((body) => body.zsh);
    let code = scan.cleaned;

    for (const body of heredocs) {
        if (!body.zsh) {
            code = blankRange(code, body.start, body.end);
        }
    }

    // A fresh zsh starts with the default options and sees only exported variables, so an
    // option or an unexported assignment made outside its body never reaches a use inside.
    const crossesIntoFresh = (from: number, to: number): boolean =>
        fresh.some((body) => within(body, to) && !within(body, from));

    const assignments: Assignment[] = [];
    const uses: ParameterUse[] = [];

    const record = (token: Span, scope: Range, exported: boolean): number => {
        const m = ASSIGNMENT.exec(token.text);

        if (!m) {
            return token.start + token.text.length;
        }

        const value = assignedValue(command, scan.cleaned, token.start + m[0].length);
        assignments.push({ name: m[1], start: token.start, scope, exported, ...value });
        return value.end;
    };

    const addUse = (token: Span, use: Omit<ParameterUse, "name" | "start" | "end">) => {
        const m = PARAMETER.exec(token.text);
        const end = token.start + token.text.length;
        const before = command[token.start - 1];
        const after = command[end];

        // Whole words only: `$dir/x`, `$files"/x"` and `--path=$x` are not a list where one is expected.
        if (
            !m ||
            (before !== undefined && !/[\s;&|(]/.test(before)) ||
            (after !== undefined && !/[\s;&|)<>]/.test(after))
        ) {
            return;
        }

        uses.push({ name: m[1] ?? m[2], start: token.start, end, ...use });
    };

    // `files=( … )` is an array, which zsh iterates per element; `record` gives it the kind
    // `array`. Its items are a list context like a `for` list (`arr=( $x )` holds ONE element in
    // zsh). The statement splitter cuts on the parens, so the body is blanked or
    // `arr=( foo $x )` would read as a command `foo $x`.
    let cleaned = code;

    for (const m of code.matchAll(ARRAY_ASSIGNMENT)) {
        const open = m.index + m[0].length - 1;
        const close = matchParen(code, open);
        const items = tokenize({ text: code.slice(open + 1, close), start: open + 1 });

        for (const item of items) {
            addUse(item, { loop: true, soleItem: items.length === 1, optionValue: false });
        }

        cleaned = blankRange(cleaned, open + 1, close);
    }

    const pipelines = splitSubstitutions(cleaned)
        .flatMap((unit) => splitStatements(unit))
        .sort((a, b) => a.start - b.start)
        .map((statement) => splitPipeline(statement));

    // A subshell keeps its assignments and its `setopt` from everything outside it: a `( … )`,
    // a fresh zsh, and every element of a pipeline but the last, which zsh runs in a subshell.
    const whole: Range = { start: 0, end: command.length };
    const scopes: Range[] = [
        ...fresh,
        ...parenRanges(code),
        ...pipelines.flatMap((elements) =>
            elements.slice(0, -1).map((element) => ({ start: element.start, end: element.start + element.text.length }))
        ),
    ];
    // The innermost scope around a position: the one that starts last, or ends first on a tie
    // (a `( … )` on the first line of a heredoc body starts where the body starts).
    const scopeAt = (at: number): Range =>
        scopes.reduce(
            (best, s) =>
                within(s, at) && (s.start > best.start || (s.start === best.start && s.end < best.end)) ? s : best,
            whole
        );

    for (const elements of pipelines) {
        for (const element of elements) {
            const scope = scopeAt(element.start);
            const all = tokenize(element);
            let first = 0;

            while (first < all.length && RESERVED_PREFIX.has(all[first].text)) {
                first++;
            }

            const head = all[first]?.text;

            if (head === undefined) {
                continue;
            }

            if (head === "for" || head === "select") {
                if (all[first + 2]?.text === "in") {
                    const items = all.slice(first + 3);

                    for (const item of items) {
                        addUse(item, { loop: true, soleItem: items.length === 1, optionValue: false });
                    }
                }

                continue;
            }

            // Leading `name=value` words. A quoted value keeps its `$x` expansions in the
            // cleaned text, so drop every token the value itself covers.
            const tokens: Span[] = [];
            let valueEnd = -1;
            let leading = true;

            for (const token of all.slice(first)) {
                if (token.start < valueEnd) {
                    continue;
                }

                if (leading && ASSIGNMENT.test(token.text)) {
                    valueEnd = record(token, scope, false);
                    tokens.push(token);
                    continue;
                }

                leading = false;
                tokens.push(token);
            }

            const cmd = commandTokenIndex(tokens, command);

            if (cmd === -1) {
                continue;
            }

            const word = commandWord(tokens[cmd].text);
            const args = tokens.slice(cmd + 1);

            // `local files=$(…)`, `export LIST="a b"`: assignments too.
            if (DECLARATIONS.has(word)) {
                const exported = word === "export" || args.some((token) => /^-[A-Za-z]*x/.test(token.text));
                let end = -1;

                for (const token of args) {
                    if (token.start >= end) {
                        end = record(token, scope, exported);
                    }
                }

                continue;
            }

            if (ONE_STRING_COMMANDS.has(word) || word.startsWith("$")) {
                continue;
            }

            for (let k = 0; k < args.length; k++) {
                const previous = k === 0 ? "" : args[k - 1].text;

                if (REDIRECT.test(previous)) {
                    continue;
                }

                addUse(args[k], { loop: false, soleItem: false, optionValue: previous.startsWith("-") });
            }
        }
    }

    // `setopt shwordsplit` or `emulate sh` splits the uses after it in its own subshell.
    const splitOn = [...code.matchAll(SPLIT_ENABLED)].map((m) => ({ at: m.index, scope: scopeAt(m.index) }));
    // Once exported, a variable stays exported, and a later plain assignment changes what a child sees.
    const exportedAt = (a: Assignment): boolean =>
        assignments.some((b) => b.name === a.name && b.exported && b.start <= a.start && within(b.scope, a.start));
    let marked: string | null = null;
    const hits: WordSplitHit[] = [];

    for (const use of uses) {
        if (splitOn.some((s) => s.at < use.start && within(s.scope, use.start) && !crossesIntoFresh(s.at, use.start))) {
            continue;
        }

        // The last assignment that took effect before the use, made in a scope that reaches it.
        const source = assignments
            .filter((a) => a.name === use.name && a.end <= use.start && within(a.scope, use.start))
            .at(-1);

        if (!source || !splits(source.kind, use)) {
            continue;
        }

        if (crossesIntoFresh(source.start, use.start) && !exportedAt(source)) {
            continue;
        }

        // Inside `"a $files b"` it is quoted on purpose. Computed once, and only for a candidate.
        marked ??= stripShellNoise(command.replace(EXPANSION_MARK, MARK));

        if (marked[use.start] !== MARK) {
            continue;
        }

        hits.push({ use, flag: source.flag });
    }

    return hits.sort((a, b) => a.use.start - b.use.start);
}

// Whether zsh's one-word reading of this use differs from what the command meant.
function splits(kind: ValueKind, use: ParameterUse): boolean {
    if (kind === "list") {
        return true;
    }

    if (kind === "words") {
        return use.loop || !use.optionValue;
    }

    if (kind === "search") {
        return use.loop;
    }

    // Output of a command the tables cannot place: only a loop over it alone is surely a list.
    return kind === "unknown" && use.loop && use.soleItem;
}

export const zshWordSplit: ShellRule = {
    id: "zsh-word-split",
    kind: "misread",
    title: "an unquoted $var holding a list stays ONE word in zsh (no SH_WORD_SPLIT)",
    severity: "block",
    why:
        "zsh does not split an unquoted parameter expansion on whitespace, so `for f in $files` runs once " +
        "with the whole list as one value and `cmd $list` gets one argument, and the result is silently " +
        "wrong. Write `${(f)files}` to split command output per line or `${=list}` to split on spaces " +
        '(an unquoted `$( … )` is already split, and `"$x"` stays one word).',
    wrong: "files=$(git diff --name-only | head -40); for f in $files; do wc -l $f; done",
    right: "files=$(git diff --name-only | head -40); for f in ${(f)files}; do wc -l $f; done",
    evidence:
        "2026-11-02: `files=$(git show --name-only … | head -40); for f in $files` looped once over the whole " +
        "list and reported 0/1 matches. A replay of 200,000 recent Bash commands the same day: 76 hits, each one the " +
        "bug; the draft that also blocked a search used as an argument hit 74 in 40,000, 58 of them correct commands.",
    detect(scan): ShellMatch | null {
        const hits = wordSplitHits(scan);

        if (hits.length === 0) {
            return null;
        }

        let suggestion = scan.command;

        for (const { use, flag } of [...hits].reverse()) {
            suggestion = `${suggestion.slice(0, use.start)}\${${flag}${use.name}}${suggestion.slice(use.end)}`;
        }

        const first = hits[0].use;
        return { matched: scan.command.slice(first.start, first.end), index: first.start, suggestion };
    },
};

export const zshRules: readonly ShellRule[] = [zshGlobQualifier, bareLogCommand, zshWordSplit];
