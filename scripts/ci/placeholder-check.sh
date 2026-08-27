#!/usr/bin/env bash
# placeholder-check.sh — Keep tracked files free of values from a local list.
#
# Fixtures, worked examples and pasted terminal output accumulate values copied
# from whatever machine and account the author happened to be using. This check
# fails the build when a tracked file still contains one of them, so the fix
# happens at review time instead of after publication.
#
# The list of values lives OUTSIDE this repository, on purpose. A checked-in
# list would be the very thing it exists to keep out of the tree: one file,
# conveniently labelled, holding every value in one place. Nothing here scans
# for anything unless a list is supplied, and the check reports that plainly
# rather than passing quietly.
#
# Supplying the list, in order of precedence:
#
#   1. $PLACEHOLDER_MARKERS_FILE — an absolute path to the list.
#   2. ~/.genesis-tools/placeholder-check/markers.txt
#
# Format: one entry per line, `label<TAB>pattern`. `pattern` is PCRE, matched
# case-insensitively against every tracked file. Blank lines and lines starting
# with `#` are ignored. A line with no tab is treated as a pattern whose label
# is the pattern itself.
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

EXIT=0
CHECKED=0

scan() {
    local label="$1"
    local pattern="$2"
    local hits
    local status
    # `-i` is not optional: a value is spelled however the person typing it felt
    # at the time, and a case-sensitive pass silently misses half of them.
    hits=$(git grep -nIPi -e "$pattern" -- .) && status=0 || status=$?

    # 0 = matched, 1 = no match, anything above = the scan itself broke. A plain
    # `|| true` would turn that into empty output and report the tree clean, the
    # exact silent pass this repo has already shipped twice.
    if [ "$status" -gt 1 ]; then
        echo "::error:: \`git grep\` exited ${status} while scanning for ${label} — this check checked nothing."
        exit "$status"
    fi

    CHECKED=$((CHECKED + 1))

    if [ -n "$hits" ]; then
        echo "✗ ${label}"
        echo "$hits" | sed 's/^/    /'
        echo
        EXIT=1
    fi
}

echo "→ Checking tracked files against ${MARKERS}..."

while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        "" | \#*) continue ;;
    esac

    if [[ "$line" == *$'\t'* ]]; then
        scan "${line%%$'\t'*}" "${line#*$'\t'}"
    else
        scan "$line" "$line"
    fi
done < "$MARKERS"

if [ "$CHECKED" -eq 0 ]; then
    echo "::error:: ${MARKERS} contained no usable entries, so nothing was checked."
    exit 1
fi

if [ "$EXIT" -eq 0 ]; then
    echo "✓ ${CHECKED} pattern(s) checked, no matches in tracked files"
else
    echo "Replace the values above with placeholders before merging."
fi

exit "$EXIT"
