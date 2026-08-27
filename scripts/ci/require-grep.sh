#!/usr/bin/env bash
# Sourced by every guard that greps the tree.
#
# WHY THIS EXISTS: the guards are written as `if <grep> <pattern>; then fail; fi`.
# When the grep binary is MISSING the shell answers 127, `if` reads that as
# false, and the guard prints OK having checked nothing. That is what happened
# on CI for weeks: ubuntu-latest has no ripgrep, so logging-guard and
# ai-credentials-guard reported OK on every run while enforcing nothing.
# A guard that cannot run must fail loudly, never pass quietly.
#
# The guards use `git grep -P`: nothing to install (git is always present in a
# checkout), and it searches only TRACKED files, which is what these guards
# want and what makes the old node_modules/dist excludes unnecessary.

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "::error:: not inside a git work tree, so \`git grep\` cannot scan anything — this guard would pass without checking."
    exit 1
fi

# Probe PCRE support by reading STDERR ONLY. Matching lines go to stdout and
# must never be inspected: an earlier version grepped the matches themselves for
# the word "invalid", hit a source line containing it, and declared PCRE broken.
pcre_err=$(git grep -P -q -e 'x\d' -- . 2>&1 >/dev/null) || true
if [ -n "$pcre_err" ]; then
    echo "::error:: \`git grep -P\` is unusable here, so the guard patterns cannot be evaluated: ${pcre_err}"
    echo "::error:: Every \`if git grep -P …\` below would error out and read as \"no matches\" — a silent pass."
    exit 1
fi
