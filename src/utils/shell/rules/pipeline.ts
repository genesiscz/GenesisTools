// Pipeline exit-status rules.
//
// `$?` after a pipeline is the LAST element's status. `cmd 2>&1 | tail -20;
// echo "exit=$?"` prints tail's 0 while cmd failed. The Bash tool runs zsh, where
// bash's ${PIPESTATUS[0]} expands to nothing; zsh spells it $pipestatus[1].

import {
    cleanedBody,
    commandTokenIndex,
    commandWord,
    nextRawArgument,
    originalSlice,
    RESERVED_PREFIX,
    type ShellScan,
    type Span,
    simpleCommandWord,
    splitPipeline,
    splitStatements,
    tokenize,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

// Filters whose exit status says nothing about the command feeding them: they
// exit 0 whenever they could read their input.
const STATUS_MEANINGLESS = new Set([
    "head",
    "tail",
    "wc",
    "tee",
    "cat",
    "sort",
    "uniq",
    "cut",
    "tr",
    "column",
    "fold",
    "nl",
    "rev",
    "tac",
    "paste",
    "less",
    "more",
]);

// Filters whose status is meaningful in SOME usages (`grep` exits 1 on no match,
// `jq -e`, an awk `exit 1`), so `$?` after them may be exactly what was wanted.
const STATUS_AMBIGUOUS = new Set(["grep", "egrep", "fgrep", "rg", "jq", "sed", "awk", "yq"]);

const EXIT_STATUS_REF = /\$\?|\$\{\?\}/;
const PIPESTATUS_REF = /pipestatus/i;
// One element's status, with a literal index: `$pipestatus[2]`, `${pipestatus[2]}`.
const PIPESTATUS_INDEX = /\$\{pipestatus\[(\d+)\]\}?|\$pipestatus\[(\d+)\]/g;
// The label in front of a read, in the raw text: `biome=`, `"tsgo=`.
const READ_LABEL = /([A-Za-z_][\w-]*)="?$/;
// Commands that test a path exists, given -e, -d or -f.
const EXISTENCE_TESTS = new Set(["[", "[[", "test"]);
// Words that create, move or remove the path after them, so a later existence check shows whether they worked.
const CHANGES_PATH = new Set([
    "remove",
    "release",
    "add",
    "move",
    "prune",
    "rm",
    "rmdir",
    "mv",
    "cp",
    "mkdir",
    "ln",
    "touch",
]);
const REDIRECT = /^\d*&?[<>]/;
// A word as typed: quoted parts and a `$( … )` without nested parens stay inside it.
const TYPED_WORD = /(?:'[^']*'|"(?:[^"\\]|\\.)*"|\$\([^()]*\)|\\.|[^\s'"\\])+/g;
const BASH_WORD = /(^|[\s;&|(])(bash|sh)(\s|$)/;

// A label in front of the `$?` that names the filter or a match: `grep_exit=`, `count-rc=`, `match-exit=`.
const MATCH_LABEL =
    /(^|[^A-Za-z])(grep|egrep|fgrep|rg|jq|yq|awk|sed|match(es|ed)?|found|hits?|count|search)(?![A-Za-z])/gi;
const MATCH_WORD = /^(match(es|ed)?|found|hits?|count|search)$/i;
const STDERR_REDIRECT = /2>|&>|>&/;

// The Bash tool runs zsh. A `-c` argument or a heredoc names its own shell.
const OUTER_SHELL = "zsh";
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// The first pipeline element's status in each shell. dash and ksh93 keep none.
const LEFT_STATUS: ReadonlyMap<string, string> = new Map([
    ["zsh", "${pipestatus[1]}"],
    ["bash", "${PIPESTATUS[0]}"],
    ["sh", "${PIPESTATUS[0]}"],
]);

// A pipeline, its elements, the next statement, which reads `$?`, and the statements after that.
interface PipelineRead {
    pipeline: Span;
    elements: Span[];
    consumer: Span;
    later: Span[];
}

// A part of the command that a shell of its own runs (a `-c` argument, a heredoc fed to a shell),
// or a backtick body, which the shell around it runs.
interface ShellBody {
    start: number;
    end: number;
    // The shell's command word; null for a backtick body, "" when the invocation was not found.
    shell: string | null;
    // pipefail as the body starts, from the invocation's own options (`bash -o pipefail -c`).
    pipefail: boolean;
    // The shell around it expands `$` in the body first: a double-quoted `-c` argument, an unquoted heredoc.
    expandedOutside: boolean;
}

// zsh ignores case and underscores in an option name, and a `no` prefix inverts it.
function pipefailOption(name: string): boolean | null {
    const normalized = name.toLowerCase().replace(/_/g, "");
    return normalized === "pipefail" ? true : normalized === "nopipefail" ? false : null;
}

// What a list of options does to pipefail: true turns it on, false off, null leaves it. Covers
// `-o pipefail`, `-euo pipefail`, `-o errexit -o pipefail` and `+o pipefail`. With `long`, also a
// shell invocation's `--pipefail` and `--no-pipe-fail`: zsh ignores `-` in a long option too.
function optionsPipefail(args: string[], long: boolean): boolean | null {
    let change: boolean | null = null;

    for (let k = 0; k < args.length; k++) {
        const flag = /^([-+])[A-Za-z]*o$/.exec(args[k]);
        let on: boolean | null = null;

        if (flag && k + 1 < args.length) {
            on = pipefailOption(args[k + 1]);
        } else if (long && args[k].startsWith("--")) {
            on = pipefailOption(args[k].slice(2).replace(/-/g, ""));
        }

        if (on !== null) {
            change = flag?.[1] === "+" ? !on : on;
        }
    }

    return change;
}

// What one statement does to pipefail: `set` with the options above, `setopt pipefail` and
// `unsetopt pipefail`.
function pipefailChange(command: string, statement: Span): boolean | null {
    const tokens = tokenize(statement);
    const index = commandTokenIndex(tokens, command);

    if (index === -1) {
        return null;
    }

    const word = tokens[index].text;
    const args = tokens.slice(index + 1).map((token) => token.text);
    let change: boolean | null = null;

    if (word === "set") {
        change = optionsPipefail(args, false);
    } else if (word === "setopt" || word === "unsetopt") {
        for (const arg of args) {
            const on = pipefailOption(arg);

            if (on !== null) {
                change = word === "setopt" ? on : !on;
            }
        }
    }

    return change;
}

// The smallest span that holds `position`.
function innermost<T extends { start: number; end: number }>(spans: T[], position: number): T | undefined {
    return spans
        .filter((span) => position >= span.start && position < span.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}

// The shell command whose body opens at `at`: the last pipeline element on that line of the cleaned
// text around it, when its command word is a shell. `args` are its tokens before the body.
function invocationBefore(
    command: string,
    text: string,
    base: number,
    at: number
): { shell: string; args: string[] } | null {
    const lineStart = text.lastIndexOf("\n", at - base - 1) + 1;
    const statement = splitStatements({ text: text.slice(lineStart, at - base), start: base + lineStart }).pop();
    const element = statement ? splitPipeline(statement).pop() : undefined;
    const tokens = element ? tokenize(element) : [];
    const index = commandTokenIndex(tokens, command);
    const shell = index === -1 ? "" : commandWord(tokens[index].text);
    return SHELLS.has(shell) ? { shell, args: tokens.slice(index + 1).map((token) => token.text) } : null;
}

const bodiesByScan = new WeakMap<ShellScan, ShellBody[]>();

// Every body of the command that a shell of its own or a backtick substitution runs. Found once per
// scan, and only when a rule has a candidate pipeline.
function shellBodies(scan: ShellScan): ShellBody[] {
    const cached = bodiesByScan.get(scan);

    if (cached) {
        return cached;
    }

    const ranges = scan.executableRanges;
    // The cleaned text of the smallest body that `holds` accepts, or of the command, and its offset.
    const around = (holds: (range: { start: number; end: number }) => boolean) => {
        const parent = ranges.filter(holds).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        return parent
            ? { text: cleanedBody(scan.command, parent), base: parent.start }
            : { text: scan.cleaned, base: 0 };
    };
    const bodies: ShellBody[] = [];

    // The scanner keeps a heredoc as code when a shell word stands on its line; it counts here when the
    // command the operator belongs to is that shell.
    for (const heredoc of scan.heredocs) {
        const { text, base } = around((range) => range.start <= heredoc.opener && heredoc.opener < range.end);
        const invocation = invocationBefore(scan.command, text, base, heredoc.opener);

        if (invocation) {
            bodies.push({
                start: heredoc.start,
                end: heredoc.end,
                shell: invocation.shell,
                pipefail: optionsPipefail(invocation.args, true) ?? false,
                expandedOutside: !heredoc.quoted,
            });
        }
    }

    for (const range of ranges) {
        const quote = scan.command[range.start - 1];

        if (quote === "`") {
            bodies.push({ ...range, shell: null, pipefail: false, expandedOutside: false });
            continue;
        }

        // A `-c` argument: the cleaned text of the shell around it holds the invocation.
        const { text, base } = around(
            (other) => other !== range && other.start <= range.start && range.end <= other.end
        );
        const invocation = invocationBefore(scan.command, text, base, range.start);
        bodies.push({
            ...range,
            shell: invocation?.shell ?? "",
            pipefail: optionsPipefail(invocation?.args ?? [], true) ?? false,
            expandedOutside: quote === '"',
        });
    }

    bodiesByScan.set(scan, bodies);
    return bodies;
}

// Whether the shell around a double-quoted `-c` argument or an unquoted heredoc expands the `$` at
// `position` before the body's own shell starts. `\$` reaches the body's shell; `\\$` is a backslash and a live `$`.
function expandedOutsideAt(scan: ShellScan, position: number): boolean {
    if (!innermost(shellBodies(scan), position)?.expandedOutside) {
        return false;
    }

    let k = position;

    while (scan.command[k - 1] === "\\") {
        k--;
    }

    return (position - k) % 2 === 0;
}

// The shell that expands a `$` at `position`, or "" when none can be named, such as the shell around
// the body that expands it first.
function shellAt(scan: ShellScan, position: number): string {
    const body = innermost(shellBodies(scan), position);

    if (!body) {
        return OUTER_SHELL;
    }

    if (expandedOutsideAt(scan, position)) {
        return "";
    }

    return body.shell ?? shellAt(scan, body.start - 1);
}

// Whether the `$?` the consumer reads is the outer shell's, expanded before the body's pipeline ran.
function readOutside(scan: ShellScan, read: PipelineRead): boolean {
    const ref = EXIT_STATUS_REF.exec(read.consumer.text);
    return ref !== null && expandedOutsideAt(scan, read.consumer.start + ref.index);
}

// Whether pipefail is on at `position` in one shell's cleaned text. A statement before it turns
// it on or off. A `(` saves the setting and its `)` restores it, so the `set -o pipefail` of a
// closed subshell does not reach past it, while a `$( … )` sees what precedes it. The splitter
// cuts on parens, so they all sit in the gaps between statements. Statements and parens inside a
// `nested` body belong to another shell.
function pipefailInShell(
    command: string,
    text: string,
    base: number,
    position: number,
    inherited: boolean,
    nested: ShellBody[]
): boolean {
    let on = inherited;
    const saved: boolean[] = [];
    let cursor = 0;
    const elsewhere = (at: number) => nested.some((body) => at >= body.start && at < body.end);
    const walkTo = (to: number) => {
        for (; cursor < to; cursor++) {
            if (elsewhere(base + cursor)) {
                continue;
            }

            if (text[cursor] === "(") {
                saved.push(on);
            } else if (text[cursor] === ")") {
                on = saved.pop() ?? on;
            }
        }
    };

    for (const statement of splitStatements({ text, start: base })) {
        if (statement.start >= position) {
            break;
        }

        walkTo(statement.start - base);

        if (!elsewhere(statement.start)) {
            on = pipefailChange(command, statement) ?? on;
        }

        cursor = statement.start - base + statement.text.length;
    }

    walkTo(position - base);
    return on;
}

// Whether pipefail is on where the statement at `position` runs. A `-c` argument or a heredoc fed to
// a shell is a new shell: it starts with its invocation's options, and only its own statements
// count. A backtick body is a substitution and inherits the setting in front of it.
function pipefailOnAt(scan: ShellScan, position: number): boolean {
    const bodies = shellBodies(scan);
    const body = innermost(bodies, position);
    const start = body?.start ?? 0;
    const text = body ? cleanedBody(scan.command, body) : scan.cleaned;
    let inherited = false;

    if (body) {
        inherited = body.shell === null ? pipefailOnAt(scan, body.start - 1) : body.pipefail;
    }

    const nested = bodies.filter(
        (other) => other !== body && other.shell !== null && other.start >= start && other.end <= start + text.length
    );
    return pipefailInShell(scan.command, text, start, position, inherited, nested);
}

// The first pipeline whose NEXT statement consumes `$?`, restricted to the given set of
// last-element command words. A pipeline that runs under pipefail is skipped (its `$?` is the
// rightmost failure), and so is one the caller calls intended.
function pipelineFollowedByExitStatus(
    scan: ShellScan,
    lastWords: Set<string>,
    intended: (read: PipelineRead) => boolean = () => false
): PipelineRead | null {
    for (const statements of scan.units) {
        for (let i = 0; i + 1 < statements.length; i++) {
            const consumer = statements[i + 1];

            if (!EXIT_STATUS_REF.test(consumer.text) || PIPESTATUS_REF.test(consumer.text)) {
                continue;
            }

            const elements = splitPipeline(statements[i]);

            if (elements.length < 2 || !lastWords.has(simpleCommandWord(elements[elements.length - 1].text))) {
                continue;
            }

            const read = { pipeline: statements[i], elements, consumer, later: statements.slice(i + 2) };

            if (!pipefailOnAt(scan, statements[i].start) && !intended(read)) {
                return read;
            }
        }
    }

    return null;
}

function pipefailMatch(scan: ShellScan, read: PipelineRead): ShellMatch {
    const { pipeline } = read;
    // `then false | tail -1` is one statement, and `(set -o pipefail; then …)` does not parse, so the
    // reserved words stay in front of the subshell.
    const start = tokenize(pipeline).find((t) => !RESERVED_PREFIX.has(t.text))?.start ?? pipeline.start;
    const matched = originalSlice(scan, start, pipeline.start + pipeline.text.length);
    const end = start + matched.length;
    return {
        matched,
        index: start,
        // A subshell, not a bare `set -o pipefail;`: the statement can sit inside an `&&` list, and
        // an inserted `;` ended that list, so `cd wt && grep … | head` ran grep even when cd
        // failed. The subshell keeps the list intact, scopes pipefail, and its `$?` is the
        // pipeline's status.
        suggestion: `${scan.command.slice(0, start)}(set -o pipefail; ${matched})${scan.command.slice(end)}`,
    };
}

// An element's command word, also past a wrapper's quoted option value (`env -u 'X' tail`).
function elementWord(scan: ShellScan, element: Span): string {
    const tokens = tokenize(element);
    return commandWord(tokens[commandTokenIndex(tokens, scan.command)]?.text ?? "");
}

// An element's command word and the words after it as typed, quotes removed: a quoted word is blank in
// the cleaned text. An env-assignment prefix sits before the command word.
function typedArguments(scan: ShellScan, element: Span): { word: string; args: string[] } {
    const tokens = tokenize(element);
    const token = tokens[commandTokenIndex(tokens, scan.command)];

    if (!token) {
        return { word: "", args: [] };
    }

    const typed = originalSlice(scan, element.start, element.start + element.text.length);
    const args = [...typed.matchAll(TYPED_WORD)]
        .filter((m) => element.start + m.index > token.start)
        .map((m) => m[0].replace(/["']/g, ""));
    return { word: commandWord(token.text), args };
}

// The basenames of the paths an element creates, moves or removes: words with a `/` after a verb such as
// `remove` or `rm`, which are no option, no redirect or its target, and no `-e` or `-c` code string. A
// value such as `git -C dir` sits before the verb, and after it a one-letter option is a flag (`rm -f`).
function changedPaths(scan: ShellScan, element: Span): string[] {
    const { word, args } = typedArguments(scan, element);
    let changes = CHANGES_PATH.has(word);
    const names: string[] = [];

    for (let k = 0; k < args.length; k++) {
        const arg = args[k];

        if (REDIRECT.test(arg)) {
            k += /[<>]$/.test(arg) ? 1 : 0;
        } else if (arg === "-e" || arg === "-c") {
            k++;
        } else if (CHANGES_PATH.has(arg)) {
            changes = true;
        } else if (changes && !arg.startsWith("-") && arg.includes("/")) {
            const name = arg.replace(/\/+$/, "").split("/").pop() ?? "";

            if (/[A-Za-z0-9]/.test(name)) {
                names.push(name);
            }
        }
    }

    return names;
}

// Whether a statement checks that a path named one of `names` exists: `git worktree list | rg|grep <x>`,
// `[ -e|-d|-f <x> ]`, `test -e|-d|-f <x>` or `ls <x>`. A whole path component of <x> must be the name.
function checksExistence(scan: ShellScan, statement: Span, names: string[]): boolean {
    const [first, second] = splitPipeline(statement);
    const { word, args } = typedArguments(scan, first);
    let checked: string[] = [];

    if (word === "ls" || (EXISTENCE_TESTS.has(word) && args.some((arg) => /^-[edf]$/.test(arg)))) {
        checked = args;
    } else if (word === "git" && /\bworktree\s+list\b/.test(first.text) && second) {
        const filter = typedArguments(scan, second);
        checked = ["rg", "grep"].includes(filter.word) ? filter.args : [];
    }

    return checked.some(
        (arg, k) =>
            !arg.startsWith("-") &&
            !REDIRECT.test(arg) &&
            !(REDIRECT.test(checked[k - 1] ?? "") && /[<>]$/.test(checked[k - 1])) &&
            arg
                .replace(/\$$/, "")
                .split("/")
                .some((part) => names.includes(part))
    );
}

// Whether a statement after the `$?` read checks that a path the pipeline's first element changed exists,
// so the real outcome shows whatever the read prints.
function checkedLater(scan: ShellScan, read: PipelineRead): boolean {
    const names = changedPaths(scan, read.elements[0]);
    return names.length > 0 && read.later.some((statement) => checksExistence(scan, statement, names));
}

// The words a label can name in an element: each token, and a command path's basename.
function elementWords(element: Span): Set<string> {
    return new Set(
        tokenize(element).flatMap((token) => [token.text.toLowerCase(), commandWord(token.text).toLowerCase()])
    );
}

// curl -s fails without a word on stderr unless -S / --show-error brings the error back.
function silentCurl(element: string): boolean {
    if (simpleCommandWord(element) !== "curl") {
        return false;
    }

    const flags = tokenize({ text: element, start: 0 }).map((token) => token.text);
    const short = (letter: string) => flags.some((flag) => /^-[A-Za-z0-9]+$/.test(flag) && flag.includes(letter));
    return (flags.includes("--silent") || short("s")) && !(flags.includes("--show-error") || short("S"));
}

// The words that name what an element runs: its command word, and a git subcommand (`git grep`).
function runWords(command: string, element: Span): string[] {
    const tokens = tokenize(element);
    const index = commandTokenIndex(tokens, command);

    if (index === -1) {
        return [];
    }

    const word = commandWord(tokens[index].text);

    if (word !== "git") {
        return [word];
    }

    // `-C dir` and `-c name=value` take a value before the subcommand.
    for (let k = index + 1; k < tokens.length; k++) {
        if (tokens[k].text === "-C" || tokens[k].text === "-c") {
            k++;
        } else if (!tokens[k].text.startsWith("-")) {
            return [word, tokens[k].text];
        }
    }

    return [word];
}

// A deliberate match test: the label in front of the `$?` names the filter or a match, and a
// failure on the left still prints its own error, because no left element discards or merges
// stderr and none is a silent curl. The note adds nothing there and would spend one of the
// rule's context slots for the session. A label that names a command on the left instead
// (`jq_exit=` after `jq … | grep x`) asks for that command's status, which this `$?` is not.
function deliberateMatchTest(scan: ShellScan, read: PipelineRead): boolean {
    const ref = EXIT_STATUS_REF.exec(read.consumer.text);
    // The cleaned text blanks quoted text, so the label is read from the raw command.
    const label = scan.command.slice(read.consumer.start, read.consumer.start + (ref?.index ?? 0));
    const left = read.elements.slice(0, -1);
    const filter = simpleCommandWord(read.elements[read.elements.length - 1].text);
    const leftWords = new Set(left.flatMap((element) => runWords(scan.command, element)));
    const words = [...label.matchAll(MATCH_LABEL)].map((m) => m[2].toLowerCase());
    return (
        words.length > 0 &&
        words.every((word) => MATCH_WORD.test(word) || word === filter || !leftWords.has(word)) &&
        !read.pipeline.text.includes("|&") &&
        left.every((element) => !STDERR_REDIRECT.test(element.text) && !silentCurl(element.text))
    );
}

// Whether the end of `text` sits inside an unclosed `$(( … ))`.
function insideArithmetic(text: string): boolean {
    for (let at = text.indexOf("$(("); at !== -1; at = text.indexOf("$((", at + 1)) {
        let depth = 0;

        for (const ch of text.slice(at)) {
            depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
        }

        if (depth > 0) {
            return true;
        }
    }

    return false;
}

// Whether the `$?` at `ref` sits inside printf's format argument, the first one after `-v NAME` and `--`.
function inPrintfFormat(command: string, consumer: Span, ref: number): boolean {
    const tokens = tokenize(consumer);
    const word = tokens[commandTokenIndex(tokens, command)];
    let from = word.start + word.text.length;
    let isName = false;

    for (let arg = nextRawArgument(command, from); arg !== null; arg = nextRawArgument(command, from)) {
        const start = command.indexOf(arg, from);
        from = start + arg.length;

        if (isName) {
            isName = false;
        } else if (arg === "-v") {
            isName = true;
        } else if (arg !== "--") {
            return ref >= start && ref < from;
        }
    }

    return false;
}

// pipefail cannot correct a grep-family read: it returns the rightmost failure, and a filter that
// matched nothing already exits 1. So the corrected command prints the left status beside the
// filter's, read in the same statement and spelled for the shell that runs it: right after the
// first `$?` of an echo, or of a printf when that `$?` is inside the format (printf reuses its
// format for an extra argument), or after a lone `NAME=$?`. A `$?` inside `$(( … ))`, any other
// consumer, and a shell with no such array get none.
function leftStatusSuggestion(scan: ShellScan, consumer: Span): string | undefined {
    const ref = EXIT_STATUS_REF.exec(consumer.text);
    const refStart = consumer.start + (ref?.index ?? 0);
    const status = LEFT_STATUS.get(shellAt(scan, refStart));

    if (!ref || !status) {
        return undefined;
    }

    // The `$?` is `\$?` in a body the shell around it expands, and the inserted `$` needs the same backslash.
    const left = innermost(shellBodies(scan), refStart)?.expandedOutside ? `\\${status}` : status;
    const word = simpleCommandWord(consumer.text);
    let at = refStart + ref[0].length;
    let insert = ` left_exit=${left}`;

    if (word === "echo" || word === "printf") {
        if (
            insideArithmetic(scan.command.slice(consumer.start, refStart)) ||
            (word === "printf" && !inPrintfFormat(scan.command, consumer, refStart))
        ) {
            return undefined;
        }
    } else {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(\\?"?)\\?(?:\$\?|\$\{\?\})\2/.exec(
            scan.command.slice(consumer.start)
        );

        if (!assignment || consumer.text.slice(assignment[0].length).trim() !== "") {
            return undefined;
        }

        at = consumer.start + assignment[0].length;
        insert = ` left_${assignment[1]}=${left}`;
    }

    return scan.command.slice(0, at) + insert + scan.command.slice(at);
}

export const exitCodeAfterPipeline: ShellRule = {
    id: "exit-code-after-pipeline",
    kind: "misread",
    title: "$? read right after a pipeline reports the last filter's status, not the command's",
    severity: "block",
    why:
        "A pipeline's $? is the exit status of its LAST element. head, tail, wc, tee, cat, sort and friends " +
        "exit 0 whenever they could read their input, so the command that failed on the left reads as " +
        "exit 0. The Bash tool runs zsh, where ${PIPESTATUS[0]} expands to an empty string, so that is " +
        "not the fix either. Under pipefail, a head that stops reading early kills a producer that is still " +
        "writing: 141 (SIGPIPE), or 1 from rg, then means head had enough lines, not that the command failed.",
    wrong: 'tsgo --noEmit 2>&1 | tail -20; echo "exit=$?"',
    right: 'tsgo --noEmit > /tmp/tsgo.log 2>&1; echo "exit=$?"; tail -20 /tmp/tsgo.log   # or: set -o pipefail; … | tail; echo $?   # or: echo $pipestatus[1]   # not after head, which can stop the producer early (141)',
    evidence:
        "1,629 calls in 90 days of Claude Code transcripts, 45 sampled, none legitimate. CLAUDE.md: " +
        'a false "the CLI exits 0 on bad arguments" claim on 2026-08-13 came from `mytool … | head; $?`.',
    detect(scan) {
        // pipefail changes nothing for a `$?` that the shell around the body expanded first.
        const read = pipelineFollowedByExitStatus(
            scan,
            STATUS_MEANINGLESS,
            (candidate) => checkedLater(scan, candidate) || readOutside(scan, candidate)
        );
        return read ? pipefailMatch(scan, read) : null;
    },
};

export const exitCodeAfterPipelineChecked: ShellRule = {
    id: "exit-code-after-pipeline-checked",
    kind: "misread",
    title: "$? read right after a pipeline is the last filter's status; a later statement re-checks the outcome",
    severity: "context",
    why:
        "The number is still the LAST element's status (tail, head, wc and friends exit 0), so it does not " +
        "say whether the command on the left worked. A later statement of the same command checks whether " +
        "the path that command created, moved or removed exists, and that shows the real outcome, so the call runs.",
    wrong: 'git worktree remove /tmp/wt/pr-1 2>&1 | tail -2; echo "exit=$?"; git worktree list | rg pr-1',
    right: 'git worktree remove /tmp/wt/pr-1 > /tmp/rm.log 2>&1; echo "exit=$?"; tail -2 /tmp/rm.log; git worktree list | rg pr-1',
    evidence:
        "Audit of 71 logged exit-code-after-pipeline blocks (2026-11-01): 2 re-checked the removal right " +
        "after with `git worktree list | rg`, so the block cost a retry for a number nothing relied on.",
    detect(scan) {
        // A read that nothing re-checks blocks the whole call, and this note would add nothing to it.
        if (exitCodeAfterPipeline.detect(scan)) {
            return null;
        }

        const read = pipelineFollowedByExitStatus(scan, STATUS_MEANINGLESS, (candidate) =>
            readOutside(scan, candidate)
        );
        return read ? pipefailMatch(scan, read) : null;
    },
};

export const pipestatusIndexMismatch: ShellRule = {
    id: "pipestatus-index-mismatch",
    kind: "misread",
    title: "$pipestatus[N] right after a pipeline reads another element than the one it names",
    severity: "context",
    why:
        "zsh numbers the elements of the last pipeline from 1: in `a | b | c`, $pipestatus[2] is b's status. " +
        "An index past the last element, or 0, expands to nothing. An index on head, tail, wc and friends " +
        "reads a filter that exits 0. A label such as `biome=` names the command meant, so an index on " +
        "another element prints that element's status under the wrong name.",
    wrong: "git diff --name-only | rg '\\.ts$' | xargs bunx biome check 2>&1 | tail -3; echo biome=$pipestatus[2]",
    right: "git diff --name-only | rg '\\.ts$' | xargs bunx biome check 2>&1 | tail -3; echo biome=$pipestatus[3]",
    evidence:
        "Audit of logged guard firings (2026-11-01): `… | rg … | xargs bunx biome check 2>&1 | tail -3; " +
        "echo biome=$pipestatus[2]` printed rg's status as biome's, and no rule saw it.",
    detect(scan) {
        for (const statements of scan.units) {
            for (let i = 0; i + 1 < statements.length; i++) {
                const [pipeline, consumer] = [statements[i], statements[i + 1]];
                const elements = consumer.text.includes("pipestatus[") ? splitPipeline(pipeline) : [];

                if (elements.length < 2) {
                    continue;
                }

                // After a `)` or `}`, $pipestatus is the status of the pipeline the group sits in, and the
                // group can be one of its elements (`false | (exit 5 | true)` has two). Read in the raw text (a
                // quoted `-c` body is blank in the cleaned one), minus quoted or substituted words at the pipeline's end.
                const gap = scan.command
                    .slice(pipeline.start + pipeline.text.length, consumer.start)
                    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"|\$\([^()]*\)/g, "");

                if (/[)}]/.test(gap)) {
                    continue;
                }

                const words = elements.map(elementWords);
                const reads = [...consumer.text.matchAll(PIPESTATUS_INDEX)].map((ref) => ({
                    ref,
                    at: consumer.start + ref.index,
                    digits: ref[1] ?? ref[2],
                    n: Number(ref[1] ?? ref[2]),
                }));
                const wrong = reads.flatMap((read) => {
                    const { at, n } = read;
                    const label = READ_LABEL.exec(scan.command.slice(consumer.start, at))?.[1].toLowerCase();
                    // The elements the label names, 1-based.
                    const named = label ? words.flatMap((own, k) => (own.has(label) ? [k + 1] : [])) : [];
                    const outside = n < 1 || n > elements.length;
                    // A filter's status, unless the statement prints an element before it as well.
                    const meaningless =
                        n > 1 &&
                        !outside &&
                        STATUS_MEANINGLESS.has(elementWord(scan, elements[n - 1])) &&
                        !reads.some((other) => other.n >= 1 && other.n < n);
                    const right = !outside && (named.includes(n) || (named.length === 0 && !meaningless));
                    return right || shellAt(scan, at) !== OUTER_SHELL
                        ? []
                        : [{ ...read, to: named.length === 1 ? named[0] : 0 }];
                });
                const last = wrong.at(-1);

                if (!last) {
                    continue;
                }

                // One corrected command for every wrong read, changed from the right so offsets hold.
                const suggestion = wrong.every((read) => read.to > 0)
                    ? wrong.reduceRight((text, { ref, at, digits, to }) => {
                          const digitsAt = at + ref[0].indexOf("[") + 1;
                          return text.slice(0, digitsAt) + String(to) + text.slice(digitsAt + digits.length);
                      }, scan.command)
                    : undefined;
                return {
                    matched: scan.command.slice(pipeline.start, last.at + last.ref[0].length),
                    index: pipeline.start,
                    ...(suggestion ? { suggestion } : {}),
                };
            }
        }

        return null;
    },
};

export const exitCodeAfterGrep: ShellRule = {
    id: "exit-code-after-grep",
    kind: "misread",
    title: "$? read right after a pipeline ending in grep/rg/jq/sed/awk is that filter's status",
    severity: "context",
    why:
        "The status is grep's (1 = no match), rg's, jq's or awk's, not the command's on the left. That is " +
        "sometimes what was wanted (a match test), so this only adds context: if the number was meant to " +
        "say whether the left-hand command succeeded, it does not.",
    wrong: 'bun test 2>&1 | rg "fail"; echo "tests exit=$?"',
    right: 'bun test > /tmp/t.log 2>&1; echo "tests exit=$?"; rg "fail" /tmp/t.log',
    evidence: '340 calls in 90 days; several were deliberate (`echo "grep-exit:$?"`), hence context, not block.',
    detect(scan) {
        const read = pipelineFollowedByExitStatus(scan, STATUS_AMBIGUOUS, (candidate) =>
            deliberateMatchTest(scan, candidate)
        );

        if (!read) {
            return null;
        }

        const { pipeline, consumer } = read;
        const suggestion = leftStatusSuggestion(scan, consumer);
        return {
            matched: originalSlice(scan, pipeline.start, pipeline.start + pipeline.text.length),
            index: pipeline.start,
            ...(suggestion !== undefined ? { suggestion } : {}),
        };
    },
};

export const pipestatusUnderZsh: ShellRule = {
    id: "pipestatus-under-zsh",
    kind: "misread",
    title: "${PIPESTATUS[0]} is empty here: the Bash tool runs zsh",
    // Block, decided 2026-09-16 (D11b): there is no reading of this shape under
    // zsh that is not wrong, the corrected line is offered verbatim, and a
    // context note is capped at 3 per session while the corpus shows ~16 uses a
    // day, so after the cap the same empty `exit=` would be read as success
    // again and again.
    severity: "block",
    why:
        "PIPESTATUS is a bash array. The Bash tool runs zsh, which has no such variable, so " +
        '${PIPESTATUS[0]} expands to an empty string and `echo "exit=${PIPESTATUS[0]}"` prints `exit=` ' +
        "with nothing after it. zsh spells it $pipestatus (lowercase, 1-indexed).",
    wrong: 'cmd 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"',
    right: 'cmd 2>&1 | tail -20; echo "exit=${pipestatus[1]}"   # or: set -o pipefail; … ; echo $?',
    evidence:
        "703 calls in 90 days (480 in 30), 15 sampled, every one printed `exit=` with nothing after it. Verified " +
        'live: `false | true; echo "${PIPESTATUS[0]}|$pipestatus[1]"` prints `|1`. Promoted from context to block ' +
        "2026-09-16: the corrected command is offered verbatim, so the retry is a copy.",
    detect(scan) {
        if (BASH_WORD.test(scan.cleaned)) {
            return null;
        }

        const m = /\$\{PIPESTATUS\[([^\]]*)\][^}]*\}|\$PIPESTATUS\b/.exec(scan.cleaned);

        if (!m) {
            return null;
        }

        const matched = scan.command.slice(m.index, m.index + m[0].length);
        const idx = m[1] !== undefined ? m[1].trim() : "";
        const zshIndex = /^\d+$/.test(idx) ? String(Number(idx) + 1) : idx === "*" || idx === "@" ? idx : "1";
        const replacement = `\${pipestatus[${zshIndex}]}`;
        const suggestion = scan.command.slice(0, m.index) + replacement + scan.command.slice(m.index + m[0].length);

        return { matched, index: m.index, suggestion };
    },
};

export const pipelineRules: readonly ShellRule[] = [
    exitCodeAfterPipeline,
    exitCodeAfterPipelineChecked,
    pipestatusIndexMismatch,
    exitCodeAfterGrep,
    pipestatusUnderZsh,
];
