// shellNoise — reduce a raw shell command to its executable tokens so guards can
// scan it without matching a pattern that only lives inside a string.
//
// Shared by every guard rule (shellRules.ts) and by findGuard / rmGuard. It
// blanks everything that is data rather than code, and it does so WITHOUT
// changing the length of the text: every character that is not code becomes a
// space, newlines stay where they were (except inside quotes, where they become
// spaces so a multi-line string stays one token). An index into the cleaned
// text is therefore an index into the original command, which is what lets a
// violation point at the exact substring that tripped it.
//
// Blanked:
// - single-quoted, double-quoted and backtick spans
// - `#` comments (only at word start, so `foo#bar` and `$#` survive) and
//   full-line `//` comments (bun -e scripts)
// - heredoc bodies and their terminator line
//
// Kept, because guards need them:
// - `$?`, `${…}` and `$name[…]` expansions inside double quotes. `echo "exit=$?"`
//   is the shape the pipeline rule exists for, and it is almost always quoted.
// - `$( … )` command substitutions inside double quotes are scanned as code, so
//   `echo "n=$(ls 2>/dev/null | wc -l)"` exposes the pipeline.
// - the body of a heredoc that is fed to a shell (`bash <<'EOF'`) is scanned as
//   code, recursively, because that body IS the command that runs. Every other
//   heredoc body (`cat <<EOF`, `bun cli.ts <<'SPEC'`) is data and is blanked.
//
// A backslash escapes the next character, so `\$?` is literal and `\`+newline
// joins the continued line onto the current one.

const HEREDOC_OP = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
// The command word of the line that opens the heredoc decides whether the body
// runs: `bash <<'EOF'`, `sudo zsh -s <<EOF`, `sh - <<X`.
const SHELL_FED = /(^|[\s;&|(])(bash|sh|zsh|dash|ksh)(\s|$)/;

interface ScanResult {
    text: string;
    end: number;
}

interface PendingHeredoc {
    delim: string;
    stripTabs: boolean;
    shellFed: boolean;
}

// Blank a quoted span that runs from `start` (the opening quote) to the next
// `quote` character. Everything inside, including newlines, becomes spaces.
function blankSpan(src: string, start: number, quote: string): ScanResult {
    let end = src.indexOf(quote, start + 1);

    if (end === -1) {
        end = src.length - 1;
    }

    return { text: " ".repeat(end - start + 1), end };
}

// Double quotes: blank the text but keep `$` expansions and scan `$( … )` as code.
function scanDoubleQuoted(src: string, start: number): ScanResult {
    let out = " ";
    let i = start + 1;

    while (i < src.length) {
        const ch = src[i];

        if (ch === "\\") {
            // One blank per SOURCE character. A command ending in a backslash inside an
            // unterminated double quote has only one character left, and emitting two made
            // `cleaned` longer than `command` — which breaks the file's own invariant that an
            // index into the cleaned text is an index into the original. `scanCode` already
            // guards this; this branch did not.
            out += i + 1 < src.length ? "  " : " ";
            i += 2;
            continue;
        }

        if (ch === '"') {
            out += " ";
            return { text: out, end: i };
        }

        if (ch === "$") {
            const next = src[i + 1];

            if (next === "(") {
                const inner = scanCode(src, i + 2, true);
                out += `$(${inner.text}`;
                i = inner.end;

                if (src[i] === ")") {
                    out += ")";
                    i++;
                }

                continue;
            }

            if (next === "?" || next === "#" || next === "!" || next === "$" || next === "@" || next === "*") {
                out += `$${next}`;
                i += 2;
                continue;
            }

            if (next === "{") {
                const close = src.indexOf("}", i + 2);
                const end = close === -1 ? i + 1 : close;
                out += src.slice(i, end + 1);
                i = end + 1;
                continue;
            }

            const word = /^\$[A-Za-z_][A-Za-z0-9_]*(\[[^\]"]*\])?/.exec(src.slice(i));

            if (word) {
                out += word[0];
                i += word[0].length;
                continue;
            }
        }

        if (ch === "`") {
            const span = blankSpan(src, i, "`");
            out += span.text;
            i = span.end + 1;
            continue;
        }

        out += " ";
        i++;
    }

    return { text: out, end: src.length };
}

// Blank a run of text, keeping its newlines in place.
function blankKeepingNewlines(text: string): string {
    return text.replace(/[^\n]/g, " ");
}

// Consume heredoc body lines starting at `start` (the first character after the
// newline that ended the opening line). Returns the blanked (or, for a
// shell-fed body, scanned) text, same length as the body, plus the index of the
// terminator line's newline so the caller resumes on that newline.
function consumeHeredocBody(src: string, start: number, heredoc: PendingHeredoc): ScanResult {
    let i = start;

    while (i <= src.length) {
        let lineEnd = src.indexOf("\n", i);

        if (lineEnd === -1) {
            lineEnd = src.length;
        }

        const line = src.slice(i, lineEnd);
        const test = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;

        if (test === heredoc.delim) {
            const body = src.slice(start, i);
            const terminator = " ".repeat(line.length);
            const text = (heredoc.shellFed ? stripShellNoise(body) : blankKeepingNewlines(body)) + terminator;
            return { text, end: lineEnd };
        }

        if (lineEnd === src.length) {
            break;
        }

        i = lineEnd + 1;
    }

    // Unterminated heredoc: everything to EOF is body.
    const body = src.slice(start);
    return { text: heredoc.shellFed ? stripShellNoise(body) : blankKeepingNewlines(body), end: src.length };
}

// Where a `#` starts a comment: at the start, or after whitespace or a
// statement operator. Not after `(`: `*.log(#qN)` is a glob qualifier, and a
// comment inside a subshell always has a space before its `#`.
function isWordStart(out: string): boolean {
    if (out.length === 0) {
        return true;
    }

    return /[\s;&|]/.test(out[out.length - 1]);
}

function lineSoFar(out: string): string {
    const nl = out.lastIndexOf("\n");
    return nl === -1 ? out : out.slice(nl + 1);
}

// Scan code from `start`. With `stopAtCloseParen`, stop at the first `)` that
// closes no `(` opened inside this scan (the end of a `$( … )` substitution).
function scanCode(src: string, start: number, stopAtCloseParen: boolean): ScanResult {
    let out = "";
    let i = start;
    let depth = 0;
    let pending: PendingHeredoc | null = null;

    while (i < src.length) {
        const ch = src[i];

        if (ch === "\n") {
            out += "\n";
            i++;

            if (pending) {
                const body = consumeHeredocBody(src, i, pending);
                out += body.text;
                i = body.end;
                pending = null;
            }

            continue;
        }

        if (ch === "\\") {
            out += i + 1 < src.length ? "  " : " ";
            i += 2;
            continue;
        }

        if (ch === "'" || ch === "`") {
            const span = blankSpan(src, i, ch);
            out += span.text;
            i = span.end + 1;
            continue;
        }

        if (ch === '"') {
            const span = scanDoubleQuoted(src, i);
            out += span.text;
            i = span.end + 1;
            continue;
        }

        if (ch === "#" && isWordStart(out)) {
            let eol = src.indexOf("\n", i);
            eol = eol === -1 ? src.length : eol;
            out += " ".repeat(eol - i);
            i = eol;
            continue;
        }

        if (ch === "/" && src[i + 1] === "/" && lineSoFar(out).trim() === "") {
            let eol = src.indexOf("\n", i);
            eol = eol === -1 ? src.length : eol;
            out += " ".repeat(eol - i);
            i = eol;
            continue;
        }

        if (ch === "<" && src[i + 1] === "<" && src[i + 2] === "<") {
            // A herestring, not a heredoc.
            out += "<<<";
            i += 3;
            continue;
        }

        if (ch === "<" && src[i + 1] === "<") {
            const op = HEREDOC_OP.exec(src.slice(i));

            if (op) {
                pending = {
                    delim: op[3],
                    stripTabs: op[1] === "-",
                    shellFed: SHELL_FED.test(lineSoFar(out)),
                };
                out += " ".repeat(op[0].length);
                i += op[0].length;
                continue;
            }
        }

        if (stopAtCloseParen) {
            if (ch === "(") {
                depth++;
            } else if (ch === ")") {
                if (depth === 0) {
                    return { text: out, end: i };
                }

                depth--;
            }
        }

        out += ch;
        i++;
    }

    return { text: out, end: src.length };
}

// Remove heredoc bodies, comments and quoted spans from a shell command. The
// result has the same length as the input and the same newline positions
// outside quotes, so guards can split it and point back into the original.
export function stripShellNoise(command: string): string {
    return scanCode(command, 0, false).text;
}

// A piece of cleaned text that knows where it sits in the original command.
export interface Span {
    text: string;
    /** Offset of `text[0]` in the original command. */
    start: number;
}

// The basename of a command token: `/usr/bin/find` → `find`.
export function commandWord(token: string): string {
    return token.split("/").pop() ?? token;
}

// Tokens that run another command in their place. `timeout` and `nice` also
// take a numeric argument, which callers skip via TAKES_ARGUMENT. `xargs` is
// one too: `fd -e ts | xargs rg -rn foo` runs rg with -rn, so the rules must
// see rg as the command.
const WRAPPERS = new Set([
    "command",
    "builtin",
    "exec",
    "env",
    "sudo",
    "nohup",
    "time",
    "timeout",
    "nice",
    "caffeinate",
    "stdbuf",
    "xargs",
]);
const TAKES_ARGUMENT = new Set(["timeout", "nice"]);
// Wrapper options that consume the next token: `sudo -u user`, `timeout -k 5`,
// `nice -n 10`, `xargs -I {} -P 4 -L 1`.
const OPTION_WITH_VALUE = new Set(["-u", "-g", "-k", "-n", "-s", "-I", "-P", "-L"]);

// The token as the user typed it, read from the ORIGINAL command at the token's
// offset with surrounding quotes stripped. A cleaned token loses everything the
// scanner blanked: `"$HOME/.codex"` scans as `$HOME`, which looks like the home
// root when it is not. Stops at whitespace, so a quoted path with a space comes
// back cut short; the callers only compare against roots, which have none.
export function rawToken(command: string, token: Span): string {
    let start = token.start;

    if (start > 0 && (command[start - 1] === '"' || command[start - 1] === "'")) {
        start--;
    }

    const m = /^\S+/.exec(command.slice(start));
    return (m?.[0] ?? token.text).replace(/^["']|["']$/g, "");
}

// Whitespace-separated tokens of a span, each with its own offset.
export function tokenize(span: Span): Span[] {
    const out: Span[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null = re.exec(span.text);

    while (m) {
        out.push({ text: m[0], start: span.start + m.index });
        m = re.exec(span.text);
    }

    return out;
}

// Reserved words that sit in front of the command they introduce. The
// statement splitter does not cut on them, so `do git checkout -- "$f"` and
// `if ! grep -q x f` arrive as one statement whose real command word is the
// second token.
const RESERVED_PREFIX = new Set(["if", "then", "elif", "else", "do", "while", "until", "!"]);

// The index of the command word in a token list: skips `VAR=value` prefixes,
// reserved words like `do` / `then` / `!`, and wrappers like `sudo`, `env`,
// `timeout 30`. Returns -1 when there is none.
export function commandTokenIndex(tokens: Span[]): number {
    let i = 0;

    while (i < tokens.length) {
        const token = tokens[i].text;

        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || RESERVED_PREFIX.has(token)) {
            i++;
            continue;
        }

        const word = commandWord(token);

        if (WRAPPERS.has(word)) {
            i++;

            // `env -i`, `sudo -u user`, `timeout -k 5 30`, `nice -n 10`: skip option
            // tokens, and for timeout/nice the numeric argument(s) as well.
            while (
                i < tokens.length &&
                (tokens[i].text.startsWith("-") ||
                    (TAKES_ARGUMENT.has(word) && /^[0-9.]+[smhd]?$/.test(tokens[i].text)))
            ) {
                i += OPTION_WITH_VALUE.has(tokens[i].text) ? 2 : 1;
            }

            continue;
        }

        return i;
    }

    return -1;
}

// The original text from `start` to the end of a cleaned span. A span is
// trimmed, so a quoted last argument (blanked to spaces) falls off its end:
// `log show --predicate 'x'` cleans to `log show --predicate`. Walk the blank
// tail up to the next separator in the cleaned text, then drop the real
// trailing whitespace, and the excerpt carries the quoted argument again.
export function originalSlice(scan: { command: string; cleaned: string }, start: number, cleanedEnd: number): string {
    let end = cleanedEnd;

    while (end < scan.cleaned.length && (scan.cleaned[end] === " " || scan.cleaned[end] === "\t")) {
        end++;
    }

    while (end > start && /\s/.test(scan.command[end - 1])) {
        end--;
    }

    return scan.command.slice(start, end);
}

// The next argument after `index` as typed in the original command, quotes
// included: the value of `-name`, which the scanner blanked if it was quoted.
export function nextRawArgument(command: string, index: number): string | null {
    const m = /^\s+('[^']*'|"[^"]*"|\S+)/.exec(command.slice(index));
    return m ? m[1] : null;
}

// The command word of a simple command, "" for an empty element.
export function simpleCommandWord(element: string): string {
    const tokens = tokenize({ text: element, start: 0 });
    const index = commandTokenIndex(tokens);
    return index === -1 ? "" : commandWord(tokens[index].text);
}

// Lift `$( … )`, `<( … )` and `>( … )` out of cleaned text. Each substitution
// becomes its own unit (recursively), and the outer text keeps a blank where
// it stood, so `diff <(a | head) <(b | head); echo $?` does not read as "a
// pipeline, then $?": the `$?` belongs to diff. `$(( … ))` arithmetic stays in
// the outer text with its `|` (bitwise or) and parens blanked, so `$(( n + $? ))`
// still counts as a use of `$?` in the same statement. Backticks were already
// blanked as quotes. Every unit carries its offset into the original command.
export function splitSubstitutions(cleaned: string, base = 0): Span[] {
    const units: Span[] = [];
    let outer = "";
    let i = 0;

    while (i < cleaned.length) {
        const two = cleaned.slice(i, i + 2);

        if ((two === "$(" || two === "<(" || two === ">(") && !(two === "$(" && cleaned[i + 2] === "(")) {
            let depth = 0;
            let j = i + 1;

            for (; j < cleaned.length; j++) {
                if (cleaned[j] === "(") {
                    depth++;
                } else if (cleaned[j] === ")") {
                    depth--;

                    if (depth === 0) {
                        break;
                    }
                }
            }

            const inner = cleaned.slice(i + 2, j);
            outer += blankKeepingNewlines(cleaned.slice(i, Math.min(j, cleaned.length) + 1));
            units.push(...splitSubstitutions(inner, base + i + 2));
            i = j + 1;
            continue;
        }

        if (two === "$(" && cleaned[i + 2] === "(") {
            const close = cleaned.indexOf("))", i + 3);
            const end = close === -1 ? cleaned.length : close + 2;
            outer += cleaned.slice(i, end).replace(/[|()]/g, " ");
            i = end;
            continue;
        }

        outer += cleaned[i];
        i++;
    }

    return [{ text: outer, start: base }, ...units];
}

// `&&`, `||`, `;`, newline, a lone `&` (background), subshell parens and
// group braces. `2>&1`, `&>`, `<&` and `|&` keep their `&`; a brace is a
// separator only as its own word, so `${?}` and `${x:-y}` stay whole.
const STATEMENT_SEPARATOR = /&&|\|\||;|\n|[()]|(?<!\S)\{(?=\s)|(?<=\s)\}(?!\w)|(?<![<>&|])&(?![>&])/g;

function splitWithOffsets(span: Span, separator: RegExp): Span[] {
    const out: Span[] = [];
    const re = new RegExp(separator.source, "g");
    let last = 0;
    let m: RegExpExecArray | null = re.exec(span.text);

    const push = (from: number, to: number) => {
        const raw = span.text.slice(from, to);
        const lead = raw.length - raw.trimStart().length;
        const text = raw.trim();

        if (text.length > 0) {
            out.push({ text, start: span.start + from + lead });
        }
    };

    while (m) {
        push(last, m.index);
        last = m.index + m[0].length;
        m = re.exec(span.text);
    }

    push(last, span.text.length);
    return out;
}

// Split cleaned text into statements. Empty statements are dropped, so two
// statements are adjacent in the result whenever nothing but separators sits
// between them in the command.
export function splitStatements(unit: Span): Span[] {
    return splitWithOffsets(unit, STATEMENT_SEPARATOR);
}

// Split one statement into its pipeline elements. `|&` pipes stderr too and is
// treated as a pipe. A statement with no pipe is a one-element pipeline.
export function splitPipeline(statement: Span): Span[] {
    const normalized = { text: statement.text.replace(/\|&/g, "| "), start: statement.start };
    return splitWithOffsets(normalized, /\|/);
}

// Everything a rule needs, computed once per command.
export interface ShellScan {
    command: string;
    cleaned: string;
    /** The outer command and each command substitution, as statement lists. */
    units: Span[][];
}

export function scanShell(command: string): ShellScan {
    const cleaned = stripShellNoise(command);
    const units = splitSubstitutions(cleaned).map((unit) => splitStatements(unit));
    return { command, cleaned, units };
}
