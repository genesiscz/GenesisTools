/**
 * Shared pre-processing logic for all shell-command-fixer implementations.
 *
 * Steps:
 *  1. Strip \r (normalise line endings)
 *  2. Strip Bash() wrapper + dedent
 *  3. Join \-continuation lines (quote-aware: only outside single quotes,
 *     respects even/odd backslash runs before newline).
 *  4. Strip remaining flattened continuations on the same line (quote-aware).
 *  5. Strip trailing dangling backslash at end-of-string.
 *  6. For non-Bash() multi-line content: join terminal-wrapped lines
 *     (mid-word wrap → no space; new arg/operator → space).
 *     Detect and skip heredoc bodies (quote-aware).
 *  7. Collapse multiple spaces outside quotes (incl. backtick regions).
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

function stripBashWrapper(input: string): { content: string; wasBashWrapper: boolean; wasBashSpecifically: boolean } {
    const match = input.match(TOOL_PREFIX_RE);

    if (!match) {
        return { content: input, wasBashWrapper: false, wasBashSpecifically: false };
    }

    const prefix = match[0]; // e.g. "Bash(" or "Read("
    const isBash = prefix === "Bash(";
    const inner = input.slice(prefix.length);
    const lastParen = inner.lastIndexOf(")");

    if (lastParen === -1) {
        return { content: inner.trimEnd(), wasBashWrapper: true, wasBashSpecifically: isBash };
    }

    const content = inner.slice(0, lastParen);
    const lines = content.split("\n");

    if (lines.length === 1) {
        return { content: content.trim(), wasBashWrapper: true, wasBashSpecifically: isBash };
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

    return { content: dedented.join("\n").trim(), wasBashWrapper: true, wasBashSpecifically: isBash };
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

        if (ch === "`") {
            // Backtick substitution — preserve all content until closing backtick.
            // Backslash escapes work inside backticks.
            result += ch;
            i++;

            while (i < s.length && s[i] !== "`") {
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
                result += s[i]; // closing backtick
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

// ─── Quote-aware marker search ────────────────────────────────────────────────

/**
 * Find the first occurrence of `marker` that is NOT inside single, double, or
 * backtick quotes. Returns the index, or -1 if not found.
 */
function findUnquotedMarker(s: string, marker: string): number {
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        if (!inSingle && !inDouble && !inBacktick) {
            if (ch === "\\") {
                i++; // skip escaped char
                continue;
            }

            if (s.startsWith(marker, i)) {
                return i;
            }

            if (ch === "'") {
                inSingle = true;
            } else if (ch === '"') {
                inDouble = true;
            } else if (ch === "`") {
                inBacktick = true;
            }
        } else if (inSingle) {
            if (ch === "'") {
                inSingle = false;
            }
        } else if (inDouble) {
            if (ch === "\\") {
                i++; // skip escaped char inside double quotes
            } else if (ch === '"') {
                inDouble = false;
            }
        } else if (inBacktick) {
            if (ch === "\\") {
                i++;
            } else if (ch === "`") {
                inBacktick = false;
            }
        }
    }

    return -1;
}

// ─── Terminal-wrap line joining ───────────────────────────────────────────────

/**
 * Detect whether a line contains a heredoc marker (like `<<'EOF'`, `<<EOF`, `<<-EOF`)
 * that is NOT inside quotes. Returns the delimiter string or null.
 */
function detectHeredocMarker(line: string): string | null {
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    while (i < line.length) {
        const ch = line[i];

        if (!inSingle && !inDouble && ch === "\\") {
            // Skip escaped char outside quotes
            i += 2;
            continue;
        }

        if (!inDouble && ch === "'" && !inSingle) {
            inSingle = true;
            i++;
            continue;
        }

        if (inSingle && ch === "'") {
            inSingle = false;
            i++;
            continue;
        }

        if (!inSingle && ch === '"' && !inDouble) {
            inDouble = true;
            i++;
            continue;
        }

        if (inDouble && ch === "\\") {
            // Skip escaped char inside double quotes
            i += 2;
            continue;
        }

        if (inDouble && ch === '"') {
            inDouble = false;
            i++;
            continue;
        }

        // Only match `<<` outside quotes
        if (!inSingle && !inDouble && ch === "<" && i + 1 < line.length && line[i + 1] === "<") {
            const rest = line.slice(i);
            const m = rest.match(/^<<-?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/);

            if (m) {
                return m[1];
            }
        }

        i++;
    }

    return null;
}

// ─── Quote-state tracking ────────────────────────────────────────────────────

/**
 * Walk a string tracking `'`, `"`, `` ` `` state.
 * Returns the unclosed quote character, or null if all quotes are closed.
 */
function getQuoteState(s: string): "'" | '"' | "`" | null {
    let state: "'" | '"' | "`" | null = null;
    let i = 0;

    while (i < s.length) {
        const ch = s[i];

        if (state === "'") {
            if (ch === "'") {
                state = null;
            }

            i++;
            continue;
        }

        if (state === '"') {
            if (ch === "\\") {
                i += 2;
                continue;
            }

            if (ch === '"') {
                state = null;
            }

            i++;
            continue;
        }

        if (state === "`") {
            if (ch === "\\") {
                i += 2;
                continue;
            }

            if (ch === "`") {
                state = null;
            }

            i++;
            continue;
        }

        // Outside any quote
        if (ch === "\\") {
            i += 2;
            continue;
        }

        if (ch === "'" || ch === '"' || ch === "`") {
            state = ch;
        }

        i++;
    }

    return state;
}

// ─── Quote-aware continuation joining (V3, V4, V6) ──────────────────────────

/**
 * Join `\`+newline continuations and collapse flattened `\` + 2+ spaces,
 * but only outside single quotes (where `\` is literal). Inside double quotes
 * and backticks, `\`+newline IS a continuation per bash spec.
 *
 * Also respects even/odd backslash runs before newline:
 *   - `\\` + newline = literal backslash, newline stays (even count)
 *   - `\\\` + newline = literal backslash + continuation (odd count)
 */
function joinContinuationsQuoteAware(s: string): string {
    let result = "";
    let state: "'" | '"' | "`" | null = null;
    let i = 0;

    while (i < s.length) {
        const ch = s[i];

        // ── Inside single quotes: everything is literal ──
        if (state === "'") {
            if (ch === "'") {
                state = null;
            }

            result += ch;
            i++;
            continue;
        }

        // ── Inside double quotes: \ is special but stay quote-aware ──
        if (state === '"') {
            if (ch === '"') {
                state = null;
                result += ch;
                i++;
                continue;
            }

            if (ch === "\\") {
                // Count consecutive backslashes
                let bsCount = 0;

                while (i < s.length && s[i] === "\\") {
                    bsCount++;
                    i++;
                }

                if (i < s.length && s[i] === "\n") {
                    // Even count: all literal, newline stays
                    // Odd count: last one is continuation
                    const literalPairs = Math.floor(bsCount / 2);
                    result += "\\".repeat(literalPairs * 2);

                    if (bsCount % 2 === 1) {
                        // Odd: continuation — consume newline + leading ws
                        i++; // skip \n

                        while (i < s.length && (s[i] === " " || s[i] === "\t")) {
                            i++;
                        }
                    } else {
                        // Even: all literal, preserve newline
                        result += "\n";
                        i++; // skip \n
                    }
                } else if (i < s.length && (s[i] === " " || s[i] === "\t")) {
                    // Backslash + spaces inside double quotes — preserve literally
                    result += "\\".repeat(bsCount);
                } else {
                    result += "\\".repeat(bsCount);
                }

                continue;
            }

            result += ch;
            i++;
            continue;
        }

        // ── Inside backticks: similar to double quotes ──
        if (state === "`") {
            if (ch === "`") {
                state = null;
                result += ch;
                i++;
                continue;
            }

            if (ch === "\\") {
                result += ch;
                i++;

                if (i < s.length) {
                    result += s[i];
                    i++;
                }

                continue;
            }

            result += ch;
            i++;
            continue;
        }

        // ── Outside any quotes ──

        if (ch === "'" || ch === '"' || ch === "`") {
            state = ch;
            result += ch;
            i++;
            continue;
        }

        if (ch === "\\") {
            // Count consecutive backslashes
            let bsCount = 0;

            while (i < s.length && s[i] === "\\") {
                bsCount++;
                i++;
            }

            // Look ahead: skip optional trailing whitespace to see if \n follows.
            // This handles `\ \t\t\n  indent` as a continuation.
            let wsAfterBs = 0;

            while (i + wsAfterBs < s.length && (s[i + wsAfterBs] === " " || s[i + wsAfterBs] === "\t")) {
                wsAfterBs++;
            }

            if (i + wsAfterBs < s.length && s[i + wsAfterBs] === "\n") {
                // Backslash(es) + optional whitespace + newline
                const literalPairs = Math.floor(bsCount / 2);
                result += "\\".repeat(literalPairs * 2);

                if (bsCount % 2 === 1) {
                    // Odd: last backslash is continuation — consume ws + newline + leading indent
                    i += wsAfterBs + 1; // skip trailing ws + \n

                    while (i < s.length && (s[i] === " " || s[i] === "\t")) {
                        i++;
                    }

                    // No extra space emitted — the whitespace before the `\` is
                    // already in the result buffer (e.g. "echo hello \<nl>  world"
                    // → "echo hello world" because the space before \ is preserved).
                } else {
                    // Even: all literal, preserve the trailing ws + newline
                    i += wsAfterBs;
                    result += "\n";
                    i++; // skip \n
                }

                continue;
            }

            if (i < s.length && s[i] === "\n") {
                // Direct backslash + newline (no whitespace gap)
                const literalPairs = Math.floor(bsCount / 2);
                result += "\\".repeat(literalPairs * 2);

                if (bsCount % 2 === 1) {
                    i++; // skip \n

                    while (i < s.length && (s[i] === " " || s[i] === "\t")) {
                        i++;
                    }
                } else {
                    result += "\n";
                    i++;
                }

                continue;
            }

            if (wsAfterBs >= 2) {
                // Flattened continuation: \ + 2+ spaces on same line → single space
                result += "\\".repeat(bsCount - 1);
                result += " ";
                i += wsAfterBs;
                continue;
            }

            // No newline or continuation pattern — emit all backslashes
            result += "\\".repeat(bsCount);
            continue;
        }

        result += ch;
        i++;
    }

    return result;
}

/**
 * Join terminal-wrapped lines into a single string.
 *
 * Rules per line transition (prev → current):
 *   - If the current line (after ltrimming) is empty → treat as space
 *   - If prev ends with whitespace → join with single space
 *   - If current starts with an operator (`|`, `||`, `&&`, `;`, `&`) → join with space
 *   - If current starts with a redirect (`\d+>`, `<`, `>`, `>>`) → join with space
 *   - Mid-word heuristics (tiered):
 *     T1: alphanumeric/dot/underscore → no space
 *     Slash when prev ends with / → no space
 *     T2: context-dependent (colon, equals, prev-slash+hyphen/@, hyphen-digit)
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
            // Preserve trailing whitespace — it's a word-boundary signal from terminal
            // padding. "cat     " (padded to terminal width) tells us the next line
            // is a new arg, NOT a mid-word continuation.
            resultLines.push(raw);

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

                // V1 fix: push remaining lines as separate resultLines entries
                // instead of letting them get merged onto the delimiter line
                while (i < lines.length) {
                    resultLines.push(lines[i]);
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
                resultLines[resultLines.length - 1] = `${prev} `;
            }

            i++;
            continue;
        }

        // Quote-state check: if prev has unclosed single quote and ends with \,
        // the \+newline is literal content inside single quotes — preserve newline
        const quoteState = getQuoteState(prev);

        if (quoteState === "'" && prev.endsWith("\\")) {
            resultLines[resultLines.length - 1] = `${prev}\n${raw}`;
            i++;
            continue;
        }

        // V6: if prev ends with an even number of backslashes, the newline was
        // intentionally preserved by joinContinuationsQuoteAware (literal \\,
        // not a continuation). Preserve as separate line.
        if (prev.endsWith("\\")) {
            const prevContent = prev.trimEnd();
            let trailingBs = 0;

            for (let j = prevContent.length - 1; j >= 0 && prevContent[j] === "\\"; j--) {
                trailingBs++;
            }

            if (trailingBs % 2 === 0 && trailingBs > 0) {
                resultLines.push(raw);
                i++;
                continue;
            }
        }

        // Check for heredoc on this line (after joining, we won't enter heredoc mode
        // since the marker is now inline — this handles it appearing on a continuation line)
        const isRedirect = /^\d+[<>]/.test(trimmedCurrent) || /^[<>]{1,2}/.test(trimmedCurrent);
        // `--` (end-of-options marker / double-dash flags) is an operator boundary
        const operatorMatch = trimmedCurrent.match(/^(\|\||&&|[|;&])/);
        const isDoubleDash = /^--(\s|$)/.test(trimmedCurrent);
        const isOperator = operatorMatch !== null || isDoubleDash;
        const prevEndsWithNonSpace = prev.length > 0 && !/\s$/.test(prev);

        if (prevEndsWithNonSpace && !isRedirect && !isOperator) {
            const prevTrimmed = prev.trimEnd();
            const fc = trimmedCurrent[0];

            // TIER 1: Always-merge characters
            const isTier1 = /^[a-zA-Z0-9._]/.test(fc);

            // TIER 2: Context-dependent
            const isAfterColon = prevTrimmed.endsWith(":"); // scp host:/path, docker -v
            const isAfterEquals = prevTrimmed.endsWith("="); // --flag=value, VAR=value
            const isPathCharAfterSlash = prevTrimmed.endsWith("/") && (fc === "-" || fc === "@"); // /@babel/, /-special/
            const isHyphenDigitSuffix = fc === "-" && /[a-zA-Z0-9]$/.test(prevTrimmed) && /^-\d/.test(trimmedCurrent); // backup-2026

            let isMidWord =
                isTier1 ||
                isAfterColon ||
                isAfterEquals ||
                isPathCharAfterSlash ||
                isHyphenDigitSuffix;

            // When prev has balanced quotes and the current line has multiple
            // space-separated tokens, check if the first token looks like a
            // standalone word (pure alpha, likely a separate command/arg) vs.
            // a path/hash fragment continuation (contains digits, slashes, dots).
            if (isMidWord && quoteState === null && /\S\s+\S/.test(trimmedCurrent)) {
                const firstToken = trimmedCurrent.split(/\s/)[0];
                const isPureAlpha = /^[a-zA-Z]+$/.test(firstToken);

                if (
                    isPureAlpha &&
                    !prevTrimmed.endsWith("/") &&
                    !prevTrimmed.endsWith(":") &&
                    !prevTrimmed.endsWith("=")
                ) {
                    isMidWord = false;
                }
            }

            if (isMidWord) {
                resultLines[resultLines.length - 1] = `${prev}${trimmedCurrent}`;
            } else {
                resultLines[resultLines.length - 1] = `${prev} ${trimmedCurrent}`;
            }
        } else if (isOperator && operatorMatch) {
            // Operator injection protection: ensure space after the operator prefix
            // when it's glued to the following token (e.g. "&&bar" → "&& bar")
            const op = operatorMatch[1];
            const rest = trimmedCurrent.slice(op.length);
            const spacedCurrent = rest.length > 0 && !/^\s/.test(rest) ? `${op} ${rest}` : trimmedCurrent;
            resultLines[resultLines.length - 1] = `${prev.trimEnd()} ${spacedCurrent}`;
        } else {
            resultLines[resultLines.length - 1] = `${prev.trimEnd()} ${trimmedCurrent}`;
        }

        i++;
    }

    return resultLines.join("\n").trim();
}

// ─── Main pre-processing entry point ─────────────────────────────────────────

export function preProcess(raw: string): PreProcessResult {
    // Step 0: Strip Claude Code UI artifacts
    let s = raw.replace(/\r/g, "");

    // Find the LAST occurrence of `⏺ ToolName(` — everything before it is
    // previous output noise (error messages, prior tool results, etc.).
    const toolCallPattern = /⏺\s*(Bash|Read|Edit|Write|Grep|Glob)\(/;
    const lastToolCallIdx = (() => {
        let lastIdx = -1;

        for (const match of s.matchAll(new RegExp(toolCallPattern, "g"))) {
            if (match.index !== undefined) {
                lastIdx = match.index;
            }
        }

        return lastIdx;
    })();

    if (lastToolCallIdx > 0) {
        // Drop everything before the last ⏺ ToolName(
        s = s.slice(lastToolCallIdx);
    }

    // Strip ⏺ prefix (tool call marker in Claude Code output)
    const hadToolCall = lastToolCallIdx >= 0 || TOOL_PREFIX_RE.test(s.replace(/^⏺\s*/, ""));
    s = s.replace(/^⏺\s*/, "");

    // Strip ⎿ result lines (tool output) — everything from a line starting
    // with ⎿ onwards is the tool's output, not the command itself.
    // This is always safe: ⎿ at start-of-line (after optional whitespace) is
    // unambiguously a Claude Code tool output marker.
    s = s.replace(/\n\s*⎿[\s\S]*$/, "");

    // V2 fix: only strip inline ⎿ (mid-line) when a tool call was detected —
    // otherwise ⎿ inside quotes (e.g. `echo "result: ⎿ 42"`) would truncate.
    // Must be quote-aware: scan for unquoted ⎿ to avoid truncating quoted content.
    if (hadToolCall) {
        const markerIdx = findUnquotedMarker(s, "⎿");

        if (markerIdx >= 0) {
            // Trim trailing whitespace before the marker
            let trimStart = markerIdx;

            while (trimStart > 0 && (s[trimStart - 1] === " " || s[trimStart - 1] === "\t")) {
                trimStart--;
            }

            s = s.slice(0, trimStart);
        }
    }

    // Strip " · from line NNN" / " · lines NNN-MMM" suffixes on Read() tool calls
    s = s.replace(/\s+·\s+(?:from\s+)?lines?\s+\d+(?:[–-]\d+)?\s*\)?$/, ")");

    // Step 1: Strip tool wrapper (Bash(), Read(), etc.) + dedent
    const { content, wasBashWrapper, wasBashSpecifically } = stripBashWrapper(s);
    s = content;

    const isMultiLine = s.includes("\n");

    if (wasBashSpecifically && isMultiLine) {
        // Multi-line Bash() scripts are returned as-is (already dedented + trimmed above).
        // Other tool wrappers (Read, Edit, etc.) continue through normalization.
        return { text: s, wasBashWrapper, isMultiLine: true };
    }

    // Steps 3-5: Join \-continuations and collapse flattened continuations,
    // but only outside single quotes where \ is literal. Uses a state machine
    // that also handles even/odd backslash runs before newline (V6).
    s = joinContinuationsQuoteAware(s);

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

    // Quote-aware: only split at ` --flag` when not inside quotes or backticks
    let result = "";
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let i = 0;

    while (i < s.length) {
        const ch = s[i];

        if (!inSingle && !inDouble && !inBacktick) {
            if (ch === "\\") {
                result += s[i];

                if (i + 1 < s.length) {
                    result += s[i + 1];
                    i += 2;
                } else {
                    i++;
                }

                continue;
            }

            // Check for ` --<letter>` pattern at current position
            if (ch === " " && s[i + 1] === "-" && s[i + 2] === "-" && /[a-zA-Z]/.test(s[i + 3] ?? "")) {
                result += " \\\n  --";
                i += 4; // skip " --" + first letter already consumed by regex test

                // Append the first letter of the flag
                result += s[i - 1]; // the [a-zA-Z] char at i+3
                continue;
            }

            if (ch === "'") {
                inSingle = true;
            } else if (ch === '"') {
                inDouble = true;
            } else if (ch === "`") {
                inBacktick = true;
            }
        } else if (inSingle) {
            if (ch === "'") {
                inSingle = false;
            }
        } else if (inDouble) {
            if (ch === "\\") {
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
                inDouble = false;
            }
        } else if (inBacktick) {
            if (ch === "\\") {
                result += s[i];

                if (i + 1 < s.length) {
                    result += s[i + 1];
                    i += 2;
                } else {
                    i++;
                }

                continue;
            }

            if (ch === "`") {
                inBacktick = false;
            }
        }

        result += ch;
        i++;
    }

    return result;
}
