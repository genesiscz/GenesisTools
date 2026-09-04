#!/usr/bin/env bash
# placeholder-check.sh — Keep tracked files free of values from a local list.
#
# Fixtures, worked examples and pasted terminal output accumulate values copied
# from whatever machine and account the author happened to be using. This check
# blocks the push when a tracked file still contains one of them, so the fix
# happens before publication instead of after.
#
# The list of values lives OUTSIDE this repository, on purpose. A checked-in
# list would be the very thing it exists to keep out of the tree: one file,
# conveniently labelled, holding every value in one place. Nothing here scans
# for anything unless a list is supplied, and the check reports that plainly
# rather than passing quietly.
#
# This is a LOCAL gate, run by the pre-push hook. CI does not run it: the list
# would have to travel to the runner as a secret, and a hit would echo the
# matched lines (the very values the list exists to hide) into a public log.
#
# Supplying the list, in order of precedence:
#
#   1. $PLACEHOLDER_MARKERS_FILE — an absolute path to the list.
#   2. ~/.genesis-tools/placeholder-check/markers.txt
#
# Format: one entry per line, `label<TAB>pattern`. `pattern` is PCRE, matched
# case-insensitively against every tracked file. Blank lines and lines starting
# with `#` are ignored. A line with no tab is treated as a pattern whose label
# is the pattern itself. The label names the needle in every report: on a hit,
# and when a pattern fails to compile.
#
#   real-name<TAB>\bWile E\. Coyote\b
#   host<TAB>acme-corp\.example
#
# Usage: bash scripts/ci/placeholder-check.sh [repo-root]
# Exit 0 when clean or unconfigured, 1 on a hit, >1 when the scan itself broke.

set -euo pipefail

# Resolve this script's own directory BEFORE the `cd`. Sourcing a sibling by a
# relative path afterwards resolves it against the NEW cwd, which breaks the
# moment the check is pointed at a root outside the checkout.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Reach the repo root BEFORE the preflight: require-grep.sh refuses to continue
# when it is not inside a work tree.
cd "${1:-$SCRIPT_DIR/../..}"

# A missing grep would make every scan below return empty and read as "no hits".
source "$SCRIPT_DIR/require-grep.sh"

MARKERS="${PLACEHOLDER_MARKERS_FILE:-${HOME}/.genesis-tools/placeholder-check/markers.txt}"

if [ ! -f "$MARKERS" ]; then
    echo "→ placeholder check: not configured, nothing scanned."
    echo "  Supply a list at \$PLACEHOLDER_MARKERS_FILE or ~/.genesis-tools/placeholder-check/markers.txt."
    echo "  Format: one \`label<TAB>pattern\` per line. See the header of this script."
    exit 0
fi

echo "→ Checking tracked files against ${MARKERS}..."

# The list is parsed once into two parallel arrays. Arrays, not a temp file: a
# temp file is a second plaintext copy of every needle sitting in \$TMPDIR, it
# needs a trap, and a failed mktemp exits 1, which this script reserves for a
# hit. The argument list for 800 needles is about 20 KB, nowhere near ARG_MAX.
LABELS=()
PATTERNS=()
SKIPPED=0

while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        "" | \#*) continue ;;
    esac

    # `${line#*<TAB>}` on a tab-less line returns the line unchanged, so a
    # bare pattern gets itself as its label without a second branch.
    label="${line%%$'\t'*}"
    pattern="${line#*$'\t'}"

    # An empty pattern is not "nothing to look for". Fed to `git grep -f` it is
    # dropped without a word; fed to `-e ""` it matches every line in the tree.
    # Either way the count would lie, so it is named, skipped, and not counted.
    if [ -z "$pattern" ]; then
        echo "  ⚠ '${label}': empty pattern, skipped"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    LABELS+=("$label")
    PATTERNS+=("$pattern")
done < "$MARKERS"

CHECKED=${#PATTERNS[@]}

if [ "$CHECKED" -eq 0 ]; then
    echo "::error:: ${MARKERS} contained no usable entries, so nothing was checked."
    exit 1
fi

# The needles as one `-e … -e …` argument list. ONE `git grep` over all of them
# costs the same as a grep for one; a loop of one grep per needle spends ~7 ms
# of process start per needle and took 143 s on 813 of them.
ARGS=()

for pattern in "${PATTERNS[@]}"; do
    ARGS+=(-e "$pattern")
done

# `-i` is not optional: a value is spelled however the person typing it felt
# at the time, and a case-sensitive pass silently misses half of them.
#
# 0 = matched, 1 = no match, anything above = the scan itself broke. A plain
# `|| true` would turn that into empty output and report the tree clean, the
# exact silent pass this repo has already shipped twice.
hits=$(git grep -nIPi "${ARGS[@]}" -- .) && status=0 || status=$?

# Halving is how a single flat scan still names its needles. `bisect PROBE LO HI`
# prints the label of every needle in [LO, HI) for which PROBE, handed that
# range's `-e` arguments, answers true. A range with no answer is dropped whole,
# so k needles out of n cost about k·log2(n) greps rather than n.
bisect() {
    local probe="$1" lo="$2" hi="$3"
    local args=() i

    for ((i = lo; i < hi; i++)); do
        args+=(-e "${PATTERNS[$i]}")
    done

    if ! "$probe" "${args[@]}"; then
        return 0
    fi

    if [ $((hi - lo)) -eq 1 ]; then
        printf '%s\n' "${LABELS[$lo]}"
        return 0
    fi

    local mid=$(((lo + hi) / 2))
    bisect "$probe" "$lo" "$mid"
    bisect "$probe" "$mid" "$hi"
}

if [ "$status" -gt 1 ]; then
    # Compile-only probe: the pathspec names nothing, so no file is read and a
    # pattern that will not compile is the only thing that can fail.
    fails_to_compile() {
        local s
        git grep -qIP "$@" -- ':(top)placeholder-check-no-such-path' >/dev/null 2>&1 && s=0 || s=$?
        [ "$s" -gt 1 ]
    }

    echo "::error:: \`git grep\` exited ${status} while scanning ${CHECKED} pattern(s) — this check checked nothing."
    echo "::error:: needle(s) that do not compile as PCRE:"
    bisect fails_to_compile 0 "$CHECKED" | sed 's/^/    /'
    exit "$status"
fi

if [ -n "$hits" ]; then
    # Attribution runs only over the files that matched, never the whole tree.
    HIT_FILES=()

    while IFS= read -r -d '' file; do
        HIT_FILES+=("$file")
    done < <(git grep -lzIPi "${ARGS[@]}" -- .)

    matches_in_hits() {
        git grep -qIPi "$@" -- "${HIT_FILES[@]}"
    }

    echo "✗ placeholder-check: $(printf '%s\n' "$hits" | wc -l | tr -d ' ') line(s) in ${#HIT_FILES[@]} tracked file(s) matched a local needle"
    echo "  needle(s): $(bisect matches_in_hits 0 "$CHECKED" | paste -sd ',' - | sed 's/,/, /g')"
    printf '%s\n' "$hits" | sed 's/^/    /'
    echo
    echo "Replace the values above with placeholders before pushing."
    echo "Needles live in ${MARKERS} (not in git)."
    exit 1
fi

if [ "$SKIPPED" -gt 0 ]; then
    echo "✓ ${CHECKED} pattern(s) checked, no matches in tracked files (${SKIPPED} empty pattern(s) skipped)"
else
    echo "✓ ${CHECKED} pattern(s) checked, no matches in tracked files"
fi
