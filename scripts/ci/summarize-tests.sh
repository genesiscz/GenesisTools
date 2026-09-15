#!/usr/bin/env bash
#
# Render the `bun test` discovery log into a job-summary markdown block on stdout.
#
# Usage: summarize-tests.sh <log-path> <os-label> <install-outcome> <tests-outcome>
#
# This lived inline in `.github/workflows/ci.yml` until 2026-09-15. Shell inside YAML
# cannot be tested, and the first version shipped a defect that fires only on a GREEN
# run, so nothing on this PR would have caught it. It is a script with a suite now:
# `summarize-tests.test.ts` drives it through all five input classes.
#
# 🛑 `-e` is ON, so every command that may legitimately fail says `|| true` in place.
# The caller is a `shell: bash` step, which GitHub Actions runs as
# `bash --noprofile --norc -eo pipefail {0}`, and that combination is exactly what the
# original defect needed: `grep` exits 1 when it matches nothing, `pipefail` promotes
# that to the pipeline's status, and `-e` then aborts the step AT THE FIRST ASSIGNMENT,
# before one byte reaches the summary. A fully passing suite has no `(fail)` lines, so
# the green path aborted, the step has no `continue-on-error`, and the job went RED
# while printing nothing. The `LOG UNREADABLE` branch was unreachable for the same
# reason: a missing log makes `grep` exit 2.
set -euo pipefail

if [ "$#" -ne 4 ]; then
    echo "usage: summarize-tests.sh <log-path> <os-label> <install-outcome> <tests-outcome>" >&2
    exit 2
fi

LOG="$1"
OS_LABEL="$2"
INSTALL_OUTCOME="$3"
TESTS_OUTCOME="$4"

# No `2>/dev/null`: a missing or unreadable log must SAY so in the runner log. Silencing
# it is how "the command could not read the file" becomes indistinguishable from "the
# file holds no failures", which is the false green this whole step exists to prevent.
# The `PASSES` positive control below turns that case into a banner either way.
fail_lines() { grep '(fail)' "$LOG" || true; }
pass_lines() { grep '(pass)' "$LOG" || true; }

# Count with `grep | wc -l`, never `grep -c`. On a file with no match `grep -c` prints 0
# AND exits 1, so a `|| echo 0` fallback appends a SECOND zero: the variable becomes
# "0\n0", `[ -eq 0 ]` errors with "integer expected", and an empty log falls through to
# the success branch.
FAILS=$(fail_lines | wc -l | tr -d ' ')
# Deduplicate: bun prints each failing test twice, inline with a `[N ms]` suffix and
# again in its trailing summary without one. No match yields zero bytes, so `wc -l`
# answers 0 with no guard needed.
UNIQUE=$(fail_lines | sed 's/ \[[0-9.]*ms\]$//' | sort -u | wc -l | tr -d ' ')
# The positive control. A log that was never written, or that a killed job truncated,
# reports zero failures AND zero passes — indistinguishable from a clean run without it.
PASSES=$(pass_lines | wc -l | tr -d ' ')

echo "## ${OS_LABEL} — test discovery"
echo ""

if [ "$PASSES" -eq 0 ]; then
    echo "### ⚠️ LOG UNREADABLE — this result means nothing"
    echo ""
    echo "Zero \`(pass)\` lines, so the log is missing or truncated. A zero failure"
    echo "count here is the instrument failing, not the suite passing."
elif [ "$UNIQUE" -gt 0 ]; then
    echo "### 🛑 ${UNIQUE} FAILING TESTS (the job is still green — that is on purpose)"
    echo ""
    echo "\`${PASSES}\` \`(pass)\` lines confirm the log is readable."
    echo ""
    echo '```'
    # `|| true` because `head` closes the pipe once it has 40 lines, which hands `sort` an
    # EPIPE. Under `pipefail` that becomes the pipeline's status and `-e` aborts the step.
    # It needs VOLUME, not just 41 failures: the remaining lines have to outgrow the 64 KB
    # pipe buffer before `sort` blocks on a closed reader. Measured 2026-09-15 — 57 short
    # lines pass unguarded, 4,000 padded ones exit 141 (SIGPIPE). The neighbouring
    # "Slowest test files" step hit the same thing on its first real run (34373807424).
    { fail_lines | sed 's/ \[[0-9.]*ms\]$//' | sort -u | head -40; } || true
    echo '```'

    if [ "$UNIQUE" -gt 40 ]; then
        echo "_(showing 40 of ${UNIQUE})_"
    fi
else
    echo "### ✅ 0 failing tests — \`${PASSES}\` \`(pass)\` lines, log readable"
fi

echo ""
echo "- install step outcome: \`${INSTALL_OUTCOME}\`"
echo "- tests step outcome: \`${TESTS_OUTCOME}\`"
echo "- \`(fail)\` lines: \`${FAILS}\` raw, \`${UNIQUE}\` distinct"
echo ""
echo '<details><summary>Last 60 lines of test log</summary>'
echo ""
echo '```'
tail -n 60 "$LOG" || echo "(no test log)"
echo '```'
echo '</details>'
