#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Fix & Paste Command
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🔧
# @raycast.packageName Developer Utils

# Documentation:
# @raycast.description Fix broken bash commands from clipboard and paste. Strips Bash() wrapper, fixes broken \ continuations, rejoins terminal-wrapped paths, re-formats with proper \ per flag.
# @raycast.author genesiscz
# @raycast.authorURL https://github.com/genesiscz

CLIPBOARD=$(pbpaste)
[[ -z "$CLIPBOARD" ]] && exit 0

# --- Normalize line endings (strip \r) ---
CLIPBOARD=$(printf '%s' "$CLIPBOARD" | tr -d '\r')

IS_BASH_WRAPPED=false

# --- Strip Bash(...) wrapper from Claude Code tool output ---
if [[ "$CLIPBOARD" == Bash\(* ]]; then
    IS_BASH_WRAPPED=true
    CLIPBOARD="${CLIPBOARD#Bash(}"
    # Remove trailing ) — only the LAST one (the wrapper close)
    CLIPBOARD="${CLIPBOARD%)}"
    # Dedent: strip common leading whitespace (skip unindented lines like
    # the first line which sits right after "Bash(")
    CLIPBOARD=$(printf '%s\n' "$CLIPBOARD" | perl -0777 -pe '
        my $min = 999;
        for (split /\n/) {
            next if /^\s*$/;
            next unless /^\s/;
            /^(\s*)/;
            $min = length($1) if length($1) < $min;
        }
        s/^[ ]{$min}//gm if $min > 0 && $min < 999;
    ')
fi

# --- Fix broken lines ---
# Step 0: Strip flattened continuations — terminal copy sometimes replaces
# \+newline with \+spaces on the SAME line. "\ " (single space) is a legit
# escaped space in paths, so only strip \+2-or-more spaces.
FIXED=$(printf '%s\n' "$CLIPBOARD" | perl -pe 's/\\\h{2,}/ /g')

# Step 1: Join \-continuation lines (\ + optional whitespace + newline + whitespace → space)
FIXED=$(printf '%s\n' "$FIXED" | perl -0777 -pe 's/\\\h*\n\h*/ /g')

# Step 2: For non-Bash() content (i.e. single commands copied from terminal),
# also join terminal-wrapped lines (raw newlines from terminal width wrapping).
# Bash() content keeps its intentional newlines (multi-line scripts).
if [[ "$IS_BASH_WRAPPED" == false ]]; then
    FIXED=$(printf '%s\n' "$FIXED" | perl -0777 -pe '
        # Mid-word wraps: line ends with non-space AND next token starts with
        # a word-continuation char (alphanumeric, dot, underscore, hyphen),
        # but NOT a shell redirection like 2>/dev/null.
        # If next token starts with / ~ $ > | & — it is a new argument, NOT
        # a continuation, so fall through to the space-join below.
        s/(\S)\n\h*(?=[a-zA-Z0-9._-])(?!\d+>)/$1/g;
        # Everything else: join WITH single space
        s/\h*\n\h*/ /g;
    ')
fi

# Step 3: Collapse runs of spaces into one, trim leading/trailing
FIXED=$(printf '%s\n' "$FIXED" | sed -E 's/  +/ /g; s/^ +//; s/ +$//')

# --- Re-split single commands with proper \ per long flag ---
# Only split at --long-flags (not short -r, -rf, -c which break commands like rm/cp)
LINE_COUNT=$(printf '%s\n' "$FIXED" | wc -l | tr -d ' ')
if [[ "$LINE_COUNT" -eq 1 ]] && printf '%s' "$FIXED" | grep -qE ' --[a-zA-Z]'; then
    FIXED=$(printf '%s\n' "$FIXED" | perl -pe 's/ (--)(?=[a-zA-Z])/ \\\n  $1/g')
fi

# Strip trailing whitespace from every line
FIXED=$(printf '%s\n' "$FIXED" | sed 's/[[:space:]]*$//')

# Remove trailing blank lines
FIXED=$(printf '%s' "$FIXED" | perl -pe 'chomp if eof')

# Only update clipboard if we actually have content — never clobber with empty
if [[ -z "$FIXED" ]]; then
    exit 0
fi

printf '%s' "$FIXED" | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
