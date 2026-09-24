// Pipeline exit-status rules.
//
// `$?` after a pipeline is the LAST element's status. `cmd 2>&1 | tail -20;
// echo "exit=$?"` prints tail's 0 while cmd failed. The Bash tool runs zsh, where
// bash's ${PIPESTATUS[0]} expands to nothing; zsh spells it $pipestatus[1].

import { originalSlice, type ShellScan, type Span, simpleCommandWord, splitPipeline } from "../scan";
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
const BASH_WORD = /(^|[\s;&|(])(bash|sh)(\s|$)/;

// The first pipeline whose NEXT statement consumes `$?`, restricted to the given
// set of last-element command words.
function pipelineFollowedByExitStatus(scan: ShellScan, lastWords: Set<string>): Span | null {
    if (/\bpipefail\b/.test(scan.cleaned)) {
        return null;
    }

    for (const statements of scan.units) {
        for (let i = 0; i + 1 < statements.length; i++) {
            const next = statements[i + 1].text;

            if (!EXIT_STATUS_REF.test(next) || PIPESTATUS_REF.test(next)) {
                continue;
            }

            const elements = splitPipeline(statements[i]);

            if (elements.length < 2) {
                continue;
            }

            if (lastWords.has(simpleCommandWord(elements[elements.length - 1].text))) {
                return statements[i];
            }
        }
    }

    return null;
}

function matchFromSpan(scan: ShellScan, span: Span): ShellMatch {
    const matched = originalSlice(scan, span.start, span.start + span.text.length);
    return {
        matched,
        index: span.start,
        // A subshell, not a bare `set -o pipefail;`: the statement can sit inside an `&&` list, and
        // an inserted `;` ended that list, so `cd wt && grep … | head` ran grep even when cd
        // failed. The subshell keeps the list intact, scopes pipefail, and its `$?` is the
        // pipeline's status.
        suggestion:
            `${scan.command.slice(0, span.start)}(set -o pipefail; ${matched})` +
            scan.command.slice(span.start + matched.length),
    };
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
        "not the fix either.",
    wrong: 'tsgo --noEmit 2>&1 | tail -20; echo "exit=$?"',
    right: 'tsgo --noEmit > /tmp/tsgo.log 2>&1; echo "exit=$?"; tail -20 /tmp/tsgo.log   # or: set -o pipefail; … | tail; echo $?   # or: echo $pipestatus[1]',
    evidence:
        "1,629 calls in 90 days of Claude Code transcripts, 45 sampled, none legitimate. CLAUDE.md: " +
        'a false "the CLI exits 0 on bad arguments" claim on 2026-08-13 came from `mytool … | head; $?`.',
    detect(scan) {
        const span = pipelineFollowedByExitStatus(scan, STATUS_MEANINGLESS);
        return span ? matchFromSpan(scan, span) : null;
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
        const span = pipelineFollowedByExitStatus(scan, STATUS_AMBIGUOUS);
        return span ? matchFromSpan(scan, span) : null;
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

export const pipelineRules: readonly ShellRule[] = [exitCodeAfterPipeline, exitCodeAfterGrep, pipestatusUnderZsh];
