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
    tokenize,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

const STDERR_TO_DEVNULL = /(^|\s)2>\s*\/dev\/null(?=\s|$)/;

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

interface DevnullHit {
    statement: Span;
    /** The `2>/dev/null` token, positioned in the original command. */
    redirect: Span;
}

// The first pipeline where an element discards stderr and the elements AFTER
// it satisfy `consumes`.
function devnullThen(scan: ShellScan, consumes: (later: string[]) => boolean): DevnullHit | null {
    for (const statements of scan.units) {
        for (const statement of statements) {
            const elements = splitPipeline(statement);

            for (let k = 0; k + 1 < elements.length; k++) {
                const m = STDERR_TO_DEVNULL.exec(elements[k].text);

                if (!m) {
                    continue;
                }

                if (consumes(elements.slice(k + 1).map((e) => e.text))) {
                    const lead = m[1].length;
                    return {
                        statement,
                        redirect: { text: m[0].slice(lead), start: elements[k].start + m.index + lead },
                    };
                }
            }
        }
    }

    return null;
}

function matchFromHit(scan: ShellScan, hit: DevnullHit): ShellMatch {
    const { statement, redirect } = hit;
    const matched = originalSlice(scan, statement.start, statement.start + statement.text.length);
    // Drop the redirect and the one space before it.
    const from = scan.command[redirect.start - 1] === " " ? redirect.start - 1 : redirect.start;
    const suggestion = scan.command.slice(0, from) + scan.command.slice(redirect.start + redirect.text.length);

    return { matched, index: statement.start, suggestion };
}

export const stderrDiscardedThenCounted: ShellRule = {
    id: "stderr-discarded-then-counted",
    kind: "misread",
    title: "2>/dev/null then a count: a failure is counted as 0",
    severity: "block",
    why:
        "stderr is discarded, so a permission error, a wrong path or an unknown flag prints nothing on " +
        "stdout, and `wc -l` (or `grep -c`) then reports 0. That 0 is indistinguishable from a real " +
        'empty result, and it gets read as "there are none". Piping stdout never hides stderr, so the ' +
        "redirect buys nothing except the wrong answer.",
    wrong: "ls ~/Downloads/*.har 2>/dev/null | wc -l",
    right: "ls ~/Downloads/*.har | wc -l   # or keep stderr readable: ls … 2>/tmp/err | wc -l; cat /tmp/err",
    evidence:
        "932 calls in 90 days, 45 sampled, none where the redirect was needed. CLAUDE.md records three " +
        "wrong conclusions on separate days, including `ls ~/Downloads/*.har 2>/dev/null | wc -l` printing " +
        "0 while eight files existed (macOS TCC had refused the listing).",
    detect(scan) {
        const hit = devnullThen(scan, (later) => later.some(isCounter));
        return hit ? matchFromHit(scan, hit) : null;
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
        const hit = devnullThen(scan, (later) => !later.some(isCounter) && later.some(isReader));
        return hit ? matchFromHit(scan, hit) : null;
    },
};

export const devnullRules: readonly ShellRule[] = [stderrDiscardedThenCounted, stderrDiscardedThenRead];
