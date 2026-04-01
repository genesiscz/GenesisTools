/**
 * Shared pre-processing logic for all shell-command-fixer implementations.
 *
 * Steps:
 *  1. Strip \r (normalise line endings)
 *  2. Strip Bash() wrapper + dedent
 *  3. Join \-continuation lines (\ + optional ws + \n + optional ws → single space)
 *     MUST come before step 4 so that `\ + spaces + \n` is handled as one unit.
 *  4. Strip remaining flattened continuations on the same line
 *     (\ + 2+ spaces/tabs with no following newline → single space).
 *     Preserve `\ ` (single-space), which is a legitimate escaped space.
 *  5. Strip trailing dangling backslash at end-of-string.
 *  6. For non-Bash() multi-line content: join terminal-wrapped lines
 *     (mid-word wrap → no space; new arg/operator → space).
 *     Detect and skip heredoc bodies.
 *  7. Collapse multiple spaces outside quotes.
 *  8. Strip shell prompt prefixes.
 */

export interface PreProcessResult {
    /** The cleaned-up string */
    text: string;
    /** True when the input was wrapped in Bash(...) */
    wasBashWrapper: boolean;
    /** True when the result is a multi-line script (should not be further tokenised) */
    isMultiLine: boolean;
}

// ─── Tool call wrapper (Bash(), Read(), Edit(), etc.) ────────────────────────

/** Claude Code tool output prefixes that wrap content in ToolName(...) */
const TOOL_PREFIX_RE = /^(Bash|Read|Edit|Write|Grep|Glob)\(/;

function stripBashWrapper(input: string): { content: string; wasBashWrapper: boolean } {
    const match = input.match(TOOL_PREFIX_RE);

    if (!match) {
        return { content: input, wasBashWrapper: false };
    }

    const prefix = match[0]; // e.g. "Bash(" or "Read("
    const inner = input.slice(prefix.length);
    const lastParen = inner.lastIndexOf(")");

    if (lastParen === -1) {
        return { content: inner.trimEnd(), wasBashWrapper: true };
    }

    const content = inner.slice(0, lastParen);
    const lines = content.split("\n");

    if (lines.length === 1) {
        return { content: content.trim(), wasBashWrapper: true };
    }

    // Dedent by minimum indentation of non-empty lines (skip first line which
    // immediately follows the `(` with no indent prefix of its own).
    let minIndent = Infinity;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        if (line.trim().length === 0) {
            continue;
        }

        const match = line.match(/^(\s+)/);
        const indent = match ? match[1].length : 0;

        if (indent < minIndent) {
            minIndent = indent;
        }
    }

    if (minIndent === Infinity) {
        minIndent = 0;
    }

    const dedented = lines.map((line, i) => {
        if (i === 0) {
            return line;
        }

        return line.slice(minIndent);
    });

    return { content: dedented.join("\n").trim(), wasBashWrapper: true };
}

// ─── Prompt stripping ─────────────────────────────────────────────────────────

function stripPromptPrefix(s: string): string {
    // user@host:path$ / user@host ~/path $ (e.g. "martin@mbp ~/Projects $ npm test")
    if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[^$#%\n]*[$#%]\s+/.test(s)) {
        return s.replace(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[^$#%\n]*[$#%]\s+/, "");
    }

    if (/^\$\s/.test(s)) {
        return s.slice(2);
    }

    // NOTE: `# ` is NOT stripped — ambiguous between root prompt and comment.
    // Stripping `# rm -rf /` would be catastrophic.

    if (/^%\s/.test(s)) {
        return s.slice(2);
    }

    return s;
}

// ─── Space collapsing (quote-aware) ───────────────────────────────────────────

export function collapseSpacesOutsideQuotes(s: string): string {
    let result = "";
    let i = 0;

    while (i < s.length) {
        const ch = s[i];

        if (ch === "\\") {
            // Escaped character — preserve backslash + next char as-is
            result += s[i];

            if (i + 1 < s.length) {
                result += s[i + 1];
                i += 2;
            } else {
                i++;
            }

            continue;
        }

        if (ch === '"') {
            // Double-quoted string — consume until unescaped closing `"`
            result += ch;
            i++;

            while (i < s.length && s[i] !== '"') {
                if (s[i] === "\\") {
                    result += s[i];
                    i++;

                    if (i < s.length) {
                        result += s[i];
                        i++;
                    }
                } else {
                    result += s[i];
                    i++;
                }
            }

            if (i < s.length) {
                result += s[i]; // closing `"`
                i++;
            }

            continue;
        }

        if (ch === "'") {
            // Single-quoted string — no escapes inside
            result += ch;
            i++;

            while (i < s.length && s[i] !== "'") {
                result += s[i];
                i++;
            }

            if (i < s.length) {
                result += s[i]; // closing `'`
                i++;
            }

            continue;
        }

        if (ch === " ") {
            // Collapse run of spaces to one
            result += " ";
            i++;

            while (i < s.length && s[i] === " ") {
                i++;
            }

            continue;
        }

        result += ch;
        i++;
    }

    return result;
}

// ─── Terminal-wrap line joining ───────────────────────────────────────────────

/**
 * Detect whether a line is a heredoc marker (like `<<'EOF'`, `<<EOF`, `<<-EOF`).
 * Returns the delimiter string or null.
 */
function detectHeredocMarker(line: string): string | null {
    const m = line.match(/<<-?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/);
    return m ? m[1] : null;
}

/**
 * Join terminal-wrapped lines into a single string.
 *
 * Rules per line transition (prev → current):
 *   - If the current line (after ltrimming) is empty → treat as space
 *   - If prev ends with whitespace → join with single space
 *   - If current starts with an operator (`|`, `||`, `&&`, `;`, `&`) → join with space
 *   - If current starts with a redirect (`\d+>`, `<`, `>`, `>>`) → join with space
 *   - If current starts with a "mid-word continuation" character
 *     (`[a-zA-Z0-9._-]`) → join WITHOUT space (mid-word terminal wrap)
 *   - Otherwise → join WITH space
 *
 * Heredoc bodies: when a heredoc marker is detected on a line, the body
 * lines up to and including the closing delimiter are passed through as-is.
 */
function joinTerminalWrappedLines(lines: string[]): string {
    const resultLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const raw = lines[i];

        if (resultLines.length === 0) {
            resultLines.push(raw.trimEnd());

            // Check for heredoc on first line
            const heredocDelim = detectHeredocMarker(raw);

            if (heredocDelim !== null) {
                i++;

                while (i < lines.length) {
                    resultLines.push(lines[i]);

                    if (lines[i].trim() === heredocDelim) {
                        i++;
                        break;
                    }

                    i++;
                }

                continue;
            }

            i++;
            continue;
        }

        const prev = resultLines[resultLines.length - 1];
        const trimmedCurrent = raw.replace(/^[ \t]+/, "");

        if (trimmedCurrent.length === 0) {
            // Blank line — ensure there will be a space before next token
            if (prev.length > 0 && !/\s$/.test(prev)) {
                resultLines[resultLines.length - 1] = prev + " ";
            }

            i++;
            continue;
        }

        // Check for heredoc on this line (after joining, we won't enter heredoc mode
        // since the marker is now inline — this handles it appearing on a continuation line)
        const isRedirect = /^\d+[<>]/.test(trimmedCurrent) || /^[<>]{1,2}/.test(trimmedCurrent);
        // `--` (end-of-options marker / double-dash flags) is an operator boundary
        const isOperator = /^(\|\||&&|[|;&])/.test(trimmedCurrent) || /^--(\s|$)/.test(trimmedCurrent);
        const prevEndsWithNonSpace = prev.length > 0 && !/\s$/.test(prev);

        if (prevEndsWithNonSpace && !isRedirect && !isOperator) {
            // Mid-word chars: alphanumeric, dot, underscore only.
            // Explicitly excluded (always new-arg): `/`, `~`, `@`, `-`, `(`, `"`, `'`
            // Hyphen is excluded because `-flag` always starts a new argument.
            const isMidWord = /^[a-zA-Z0-9._]/.test(trimmedCurrent[0]);

            if (isMidWord) {
                resultLines[resultLines.length - 1] = prev + trimmedCurrent;
            } else {
                resultLines[resultLines.length - 1] = prev + " " + trimmedCurrent;
            }
        } else {
            resultLines[resultLines.length - 1] = prev.trimEnd() + " " + trimmedCurrent;
        }

        i++;
    }

    return resultLines.join("\n").trim();
}

// ─── Main pre-processing entry point ─────────────────────────────────────────

export function preProcess(raw: string): PreProcessResult {
    // Step 0: Strip Claude Code UI artifacts
    let s = raw.replace(/\r/g, "");

    // Strip ⏺ prefix (tool call marker in Claude Code output)
    s = s.replace(/^⏺\s*/, "");

    // Strip ⎿ result lines (tool output) — everything from a line starting
    // with ⎿ onwards is the tool's output, not the command itself.
    s = s.replace(/\n\s*⎿[\s\S]*$/, "");

    // Also strip inline ⎿ on the same line (e.g. "Bash(cmd)\n  ⎿ output")
    s = s.replace(/\s*⎿[\s\S]*$/, "");

    // Strip " · from line NNN" / " · lines NNN-MMM" suffixes on Read() tool calls
    s = s.replace(/\s+·\s+(?:from\s+)?lines?\s+\d+(?:[–-]\d+)?\s*\)?$/, ")");

    // Step 1: Strip tool wrapper (Bash(), Read(), etc.) + dedent
    const { content, wasBashWrapper } = stripBashWrapper(s);
    s = content;

    const isMultiLine = s.includes("\n");

    if (wasBashWrapper && isMultiLine) {
        // Multi-line scripts are returned as-is (already dedented + trimmed above)
        return { text: s, wasBashWrapper, isMultiLine: true };
    }

    // Step 3: Join \-continuation lines FIRST.
    // Consume optional whitespace BEFORE the backslash too (e.g. `cmd \<newline>arg`)
    // so that no double-space is left behind. Replace with a single space.
    // This must come before step 4 so that `\ + spaces + \n + indent` is one unit.
    s = s.replace(/[ \t]*\\[ \t]*\n[ \t]*/g, " ");

    // Step 4: Strip remaining flattened continuations (\ + 2+ spaces/tabs on same line).
    // Only after step 3 has consumed all `\...\n` pairs is it safe to collapse these.
    // Preserve `\ ` (backslash + single space) = legitimate escaped space.
    s = s.replace(/\\[ \t]{2,}/g, " ");

    // Step 5: Strip trailing dangling backslash at end of string.
    s = s.replace(/\\$/, "");

    if (!isMultiLine) {
        // Purely single-line input — collapse extra spaces and strip prompt.
        s = collapseSpacesOutsideQuotes(s);
        s = s.trim();

        // Garbage: result consists only of backslash-escape sequences (no real tokens)
        if (/^(\\[ \t]*)+$/.test(s)) {
            return { text: "", wasBashWrapper, isMultiLine: false };
        }

        s = stripPromptPrefix(s);
        return { text: s, wasBashWrapper, isMultiLine: false };
    }

    // Step 6: Join terminal-wrapped lines (multi-line input that is NOT a Bash() script).
    // After steps 3-5, continuation lines have been merged; only real terminal-wrap
    // newlines remain.
    const remainingLines = s.split("\n");

    // If there are still multiple lines (real terminal wrapping), join them.
    // If only one line remains (all \-continuations consumed), skip.
    if (remainingLines.length > 1) {
        s = joinTerminalWrappedLines(remainingLines);
    } else {
        s = remainingLines[0].trim();
    }

    // Heredoc detection: if the result still contains newlines, it's a multi-line script.
    const stillMultiLine = s.includes("\n");

    if (stillMultiLine) {
        return { text: s.trim(), wasBashWrapper, isMultiLine: true };
    }

    // Step 7: Collapse spaces (outside quotes)
    s = collapseSpacesOutsideQuotes(s);
    s = s.trim();

    // Step 8: Strip prompt prefix
    s = stripPromptPrefix(s);

    // Step 9: If the entire result consists only of backslash-space sequences
    // (e.g. `\ \ \` garbage), return empty string.
    if (/^(\\[ \t]*)+$/.test(s)) {
        return { text: "", wasBashWrapper, isMultiLine: false };
    }

    return { text: s, wasBashWrapper, isMultiLine: false };
}

// ─── Prettify (re-split at --long-flags) ────────────────────────────────────

/**
 * Re-split a single-line command at each `--long-flag`, adding `\` continuations.
 * Short flags (`-r`, `-rf`, `-c`) stay inline.
 * Multi-line strings and commands without `--` flags are returned unchanged.
 */
export function prettifyCommand(s: string): string {
    if (s.includes("\n")) {
        return s;
    }

    if (!/ --[a-zA-Z]/.test(s)) {
        return s;
    }

    return s.replace(/ (--)(?=[a-zA-Z])/g, " \\\n  $1");
}
