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
    /** Where the `<<` stands. */
    opener: number;
    quoted: boolean;
}

/** A heredoc body that a shell reads (`bash <<'EOF'`), which the scanner keeps as code. */
export interface ShellHeredoc {
    /** Where the `<<` stands. */
    opener: number;
    /** From the line after the operator to the terminator line, or to the end. */
    start: number;
    end: number;
    /** The delimiter is quoted, so the shell around it does not expand the body. */
    quoted: boolean;
}

/** Collects the shell-fed heredocs of a scan, `base` being the offset of the scanned text in the command. */
interface HeredocSink {
    list: ShellHeredoc[];
    base: number;
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
function scanDoubleQuoted(src: string, start: number, comment: string, sink?: HeredocSink): ScanResult {
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
                const inner = scanCode(src, i + 2, true, comment, sink);
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
function consumeHeredocBody(
    src: string,
    start: number,
    heredoc: PendingHeredoc,
    comment: string,
    sink?: HeredocSink
): ScanResult {
    const scanBody = (body: string): string => {
        if (!heredoc.shellFed) {
            return blankKeepingNewlines(body);
        }

        const { base = 0, list } = sink ?? {};
        list?.push({
            opener: base + heredoc.opener,
            start: base + start,
            end: base + start + body.length,
            quoted: heredoc.quoted,
        });
        return scanCode(body, 0, false, comment, list && { list, base: base + start }).text;
    };
    let i = start;

    while (i <= src.length) {
        let lineEnd = src.indexOf("\n", i);

        if (lineEnd === -1) {
            lineEnd = src.length;
        }

        const line = src.slice(i, lineEnd);
        const test = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;

        if (test === heredoc.delim) {
            return { text: scanBody(src.slice(start, i)) + " ".repeat(line.length), end: lineEnd };
        }

        if (lineEnd === src.length) {
            break;
        }

        i = lineEnd + 1;
    }

    // Unterminated heredoc: everything to EOF is body.
    return { text: scanBody(src.slice(start)), end: src.length };
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
function scanCode(
    src: string,
    start: number,
    stopAtCloseParen: boolean,
    comment: string,
    sink?: HeredocSink
): ScanResult {
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
                const body = consumeHeredocBody(src, i, pending, comment, sink);
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
            const span = scanDoubleQuoted(src, i, comment, sink);
            out += span.text;
            i = span.end + 1;
            continue;
        }

        if (ch === "#" && isWordStart(out)) {
            let eol = src.indexOf("\n", i);
            eol = eol === -1 ? src.length : eol;
            out += comment + " ".repeat(eol - i - 1);
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
                    opener: i,
                    quoted: op[2] !== "",
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
// `comment` replaces the `#` that opens a comment; originalSlice passes "#" so
// its walk can tell a comment from a blanked quoted argument.
export function stripShellNoise(command: string, comment = " "): string {
    return scanCode(command, 0, false, comment).text;
}

// A piece of cleaned text that knows where it sits in the original command.
export interface Span {
    text: string;
    /** Offset of `text[0]` in the original command. */
    start: number;
}

interface ExecutableBody extends Span {
    end: number;
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
// Wrapper options that consume the next token, PER WRAPPER: `sudo -u user`, `timeout -k 5`,
// `nice -n 10`, `xargs -I {} -P 4 -L 1`. One shared set made `sudo -n git checkout -- a.ts`
// skip `git` as the value of `-n`, which is `timeout`'s and `xargs`'s, not sudo's, and every
// rule then saw `checkout` as the command. `sudo -n` is what an agent runs, since it cannot
// answer a password prompt.
const OPTION_WITH_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
    sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]),
    timeout: new Set(["-k", "-s"]),
    nice: new Set(["-n"]),
    // BSD and GNU. GNU's `-e`, `-i` and `-l` take an optional value written onto the flag, never the next word.
    xargs: new Set(["-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "-E", "-d", "-a"]),
    env: new Set(["-u", "-C", "-S"]),
    stdbuf: new Set(["-i", "-o", "-e"]),
    caffeinate: new Set(["-t", "-w"]),
    exec: new Set(["-a"]),
};

// Long wrapper options whose REQUIRED value may be the next word (`xargs --max-args 1 rm`), and the wrapper's other
// long options (no value, or an optional one only `--name=value` gives). getopt_long takes any unambiguous prefix
// (`--max-a 1`), so a prefix consumes the next word when it names only value-taking options.
const LONG_OPTION_WITH_VALUE: Readonly<Record<string, { value: readonly string[]; other: readonly string[] }>> = {
    xargs: {
        value: ["arg-file", "delimiter", "max-args", "max-chars", "max-procs", "process-slot-var"],
        other: [
            "eof",
            "exit",
            "help",
            "interactive",
            "max-lines",
            "no-run-if-empty",
            "null",
            "open-tty",
            "replace",
            "show-limits",
            "verbose",
            "version",
        ],
    },
};

/** Whether the value after option `tokens[i]` was quoted, so the scanner blanked it and the next token is not it. */
function quotedValueFollows(tokens: Span[], i: number, command: string | undefined): boolean {
    const option = tokens[i];
    const next = tokens[i + 1];

    if (command === undefined || !option || !next) {
        return false;
    }

    return /\S/.test(command.slice(option.start + option.text.length, next.start));
}

/** Whether `wrapper`'s option `token` takes the next word as its value. */
function wrapperOptionTakesNext(wrapper: string, token: string): boolean {
    if (OPTION_WITH_VALUE[wrapper]?.has(token)) {
        return true;
    }

    const long = LONG_OPTION_WITH_VALUE[wrapper];

    if (!long || !token.startsWith("--") || token.length === 2 || token.includes("=")) {
        return false;
    }

    const name = token.slice(2);
    return (
        long.value.some((option) => option.startsWith(name)) && !long.other.some((option) => option.startsWith(name))
    );
}

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
export const RESERVED_PREFIX: ReadonlySet<string> = new Set([
    "if",
    "then",
    "elif",
    "else",
    "do",
    "while",
    "until",
    "!",
]);

// A word that is only a command substitution, as typed or as splitSubstitutions marks one that starts a
// statement. Its output names the command, so the word after it stands for the command (`$(which bunx) biome`).
const SUBSTITUTION_WORD = /^\$(?:_{2,}|\(.*\))$/s;

// The index of the command word in a token list: skips `VAR=value` prefixes,
// reserved words like `do` / `then` / `!`, a word that is only a substitution, and wrappers like `sudo`, `env`,
// `timeout 30`. Returns -1 when there is none.
//
// `command`, the scanned command the tokens point into, lets a wrapper option see a value the scanner blanked:
// `xargs -J '%' rm %` cleans to `xargs -J     rm %`, and without it `-J` would take `rm` as its value.
export function commandTokenIndex(tokens: Span[], command?: string): number {
    let i = 0;

    while (i < tokens.length) {
        const token = tokens[i].text;

        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || RESERVED_PREFIX.has(token) || SUBSTITUTION_WORD.test(token)) {
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
                if (tokens[i].text === "--") {
                    i++;
                    break;
                }

                i += wrapperOptionTakesNext(word, tokens[i].text) && !quotedValueFollows(tokens, i, command) ? 2 : 1;
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
// tail up to the next separator, then drop the real trailing whitespace, and
// the excerpt carries the quoted argument again.
//
// The walk runs in the unit the span was cut from: the innermost `-c` body or
// the command, cut at its substitutions. In scan.cleaned a quoted `-c` body is
// all blanks, so the walk ran to the end of the body, and a `"$(…)"` argument is
// code, so the walk stopped at its opening quote. In the unit, the body is code
// and a substitution is blank. A comment is marked there, so the walk stops
// before it instead of carrying it into a corrected command.
export function originalSlice(
    scan: { command: string; cleaned: string; executableRanges?: Array<{ start: number; end: number }> },
    start: number,
    cleanedEnd: number
): string {
    const range = scan.executableRanges
        ?.filter((candidate) => start >= candidate.start && cleanedEnd <= candidate.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    const source = sliceSourceOf(scan, range);
    const from = start - source.base;
    const to = cleanedEnd - source.base;
    const unitEnd = (unit: Span): number => unit.start + unit.text.length;
    // The innermost unit holding the span. The outer unit holds every span inside the source.
    const unit = source.units
        .filter((candidate) => candidate.start <= from && to <= unitEnd(candidate))
        .sort((a, b) => a.text.length - b.text.length)[0];

    if (!unit) {
        return scan.command.slice(start, cleanedEnd);
    }

    // A substitution nested in the unit is blank there except for its newlines,
    // which are not separators of this unit.
    const nested = source.units.filter((other) => other.start > unit.start && unitEnd(other) <= unitEnd(unit));
    const blankAt = (i: number): boolean =>
        unit.text[i - unit.start] === " " ||
        unit.text[i - unit.start] === "\t" ||
        nested.some((other) => i >= other.start && i < unitEnd(other));
    let walked = to;

    while (walked < unitEnd(unit) && blankAt(walked)) {
        walked++;
    }

    let end = walked === to ? cleanedEnd : source.base + walked;

    while (end > start && /\s/.test(scan.command[end - 1])) {
        end--;

        // A line continuation goes with its newline: a `\` left at the end escapes
        // whatever a corrected command appends, such as the `)` of a subshell.
        if (scan.command[end] === "\n" && scan.command[end - 1] === "\\") {
            end--;
        }
    }

    return scan.command.slice(start, end);
}

// The text a span sits in, as the shell reads it, cut into units with its
// comments marked. Offsets in `units` are local to the source.
interface SliceSource {
    /** Offset of the source in the command. */
    base: number;
    units: Span[];
}

// One source per scan and body: every match of every rule slices the same command.
const sliceSources = new WeakMap<object, Map<string, SliceSource>>();

function sliceSourceOf(scan: { command: string }, range: { start: number; end: number } | undefined): SliceSource {
    let byRange = sliceSources.get(scan);

    if (!byRange) {
        byRange = new Map();
        sliceSources.set(scan, byRange);
    }

    const key = range ? `${range.start}:${range.end}` : "";
    let source = byRange.get(key);

    if (!source) {
        source = sliceSource(scan.command, range);
        byRange.set(key, source);
    }

    return source;
}

function sliceSource(command: string, range: { start: number; end: number } | undefined): SliceSource {
    return range
        ? {
              base: range.start,
              units: splitSubstitutions(cleanedBody(command, range, "#"), 0, command.slice(range.start, range.end)),
          }
        : { base: 0, units: splitSubstitutions(stripShellNoise(command, "#"), 0, command) };
}

// The escapes the shell around a body removes before the body's own shell reads it: one level in a
// double-quoted `-c` argument (`zsh -c "rm \"\$f\""` runs `rm "$f"`), where a `\` before a newline
// joins the lines, and `\$`, `\`` and `\\` in a backtick body.
const BODY_ESCAPES: Readonly<Record<string, ReadonlySet<string>>> = {
    '"': new Set(['"', "$", "`", "\\", "\n"]),
    "`": new Set(["$", "`", "\\"]),
};

// `raw` without the backslashes that `escapes` removes, and the index in `raw` of each character kept, plus
// one past the end.
function unescapeOnce(raw: string, escapes: ReadonlySet<string>): { text: string; offsets: number[] } {
    let text = "";
    const offsets: number[] = [];

    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === "\\" && i + 1 < raw.length && escapes.has(raw[i + 1])) {
            i++;

            if (raw[i] === "\n") {
                continue;
            }
        }

        text += raw[i];
        offsets.push(i);
    }

    offsets.push(raw.length);
    return { text, offsets };
}

/**
 * The cleaned text of an executable body as its own shell reads it, the same length as the body. A
 * removed backslash is a blank, so every offset still points into the command. Shell-fed heredocs in
 * the body go to `heredocs`, in command offsets.
 */
export function cleanedBody(
    command: string,
    range: { start: number; end: number },
    comment = " ",
    heredocs?: ShellHeredoc[]
): string {
    const raw = command.slice(range.start, range.end);
    const escapes = BODY_ESCAPES[command[range.start - 1] ?? ""];

    if (!escapes || !raw.includes("\\")) {
        return scanCode(raw, 0, false, comment, heredocs && { list: heredocs, base: range.start }).text;
    }

    const { text, offsets } = unescapeOnce(raw, escapes);
    const found: ShellHeredoc[] = [];
    const cleaned = scanCode(text, 0, false, comment, { list: found, base: 0 }).text;
    const at = (k: number) => range.start + offsets[k];
    heredocs?.push(...found.map((h) => ({ ...h, opener: at(h.opener), start: at(h.start), end: at(h.end) })));
    const out = Array<string>(raw.length).fill(" ");

    for (let k = 0; k < cleaned.length; k++) {
        out[offsets[k]] = cleaned[k];
    }

    return out.join("");
}

// The next argument after `index` as typed in the original command, quotes
// included: the value of `-name`, which the scanner blanked if it was quoted.
export function nextRawArgument(command: string, index: number): string | null {
    const m = /^\s+('[^']*'|"[^"]*"|\S+)/.exec(command.slice(index));
    return m ? m[1] : null;
}

export interface ShellWords {
    words: string[];
    /** Whether the words end at `|&`, which pipes stderr along with stdout. */
    pipesStderr: boolean;
}

/**
 * The words of the simple command from `start` on, as the shell splits them, read from the original
 * command: a scanned token blanks a quoted value (`"$L/Archive"` scans as `$L`). Quotes and backslashes
 * are removed, a glued redirection is a word of its own (`--only=x>log`), and `$(…)`, `<(…)`, `${…}` and
 * backticks stay whole, so a caller can tell a value only the shell knows. Stops at an unquoted `;`,
 * `|`, `&`, `(`, `)`, newline or comment, and at the end of the `-c` or backtick body that holds
 * `start`. A double-quoted body first loses the backslashes the shell around it removes.
 */
export function wordsFrom(
    scan: Pick<ShellScan, "command" | "executableRanges">,
    start: number,
    max = Number.POSITIVE_INFINITY
): ShellWords {
    const { command } = scan;
    // A start on a body's closing quote is past the body, and so is a start right after an unquoted one.
    const body = scan.executableRanges
        .filter(
            (range) =>
                start >= range.start &&
                (start < range.end || (start === range.end && /['"`]/.test(command[range.start - 1] ?? "")))
        )
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];

    if (body && command[body.start - 1] === '"') {
        const { text } = unescapeOnce(command.slice(start, body.end), BODY_ESCAPES['"']);
        return readWords(text, 0, text.length, max);
    }

    return readWords(command, start, body?.end ?? command.length, max);
}

/** The words of `text` from `from` to `end`, split as {@link wordsFrom} splits them. */
export function readWords(text: string, from: number, end: number, max = Number.POSITIVE_INFINITY): ShellWords {
    const words: string[] = [];
    let word: string | null = null;
    let pipesStderr = false;
    let i = from;

    while (i < end && words.length < max) {
        const ch = text[i];

        if (ch === "\\") {
            word = (word ?? "") + (text[i + 1] === "\n" ? "" : (text[i + 1] ?? ""));
            i += 2;
        } else if (ch === "'") {
            const close = text.indexOf("'", i + 1);
            const stop = close === -1 || close > end ? end : close;
            word = (word ?? "") + text.slice(i + 1, stop);
            i = stop + 1;
        } else if (ch === '"') {
            const stop = closingQuote(text, i, end);
            word =
                (word ?? "") +
                text.slice(i + 1, stop).replace(/\\([$`"\\\n])/g, (_, c: string) => (c === "\n" ? "" : c));
            i = stop + 1;
        } else if (
            ch === "`" ||
            ((ch === "$" || ch === "<" || ch === ">") && text[i + 1] === "(") ||
            (ch === "$" && text[i + 1] === "{")
        ) {
            const stop = groupEnd(text, i, end);
            word = (word ?? "") + text.slice(i, stop);
            i = stop;
        } else if (ch === " " || ch === "\t") {
            if (word !== null) {
                words.push(word);
                word = null;
            }

            i++;
        } else if (
            ch === "\n" ||
            ch === "|" ||
            ch === ";" ||
            ch === "(" ||
            ch === ")" ||
            (ch === "#" && word === null) ||
            (ch === "&" && !(word !== null && /[<>]$/.test(word)) && text[i + 1] !== ">")
        ) {
            pipesStderr = ch === "|" && text[i + 1] === "&";
            break;
        } else if ((ch === "<" || ch === ">") && word !== null && !/^(?:\d+|&)$|[<>&]$/.test(word)) {
            // `--only=x>log` is the word `--only=x` and a redirection; `2>&1` is one redirection.
            words.push(word);
            word = null;
        } else {
            word = (word ?? "") + ch;
            i++;
        }
    }

    if (word !== null && words.length < max) {
        words.push(word);
    }

    return { words, pipesStderr };
}

// The index of the `"` that closes the double-quoted string opening at `i`.
function closingQuote(text: string, i: number, end: number): number {
    for (let j = i + 1; j < end; j++) {
        const c = text[j];

        if (c === "\\") {
            j++;
        } else if (c === '"') {
            return j;
        } else if (c === "`" || (c === "$" && (text[j + 1] === "(" || text[j + 1] === "{"))) {
            j = groupEnd(text, j, end) - 1;
        }
    }

    return end;
}

// The index just past the `$(…)`, `<(…)`, `${…}` or backtick group opening at `i`.
function groupEnd(text: string, i: number, end: number): number {
    if (text[i] === "`") {
        const close = text.indexOf("`", i + 1);
        return close === -1 || close >= end ? end : close + 1;
    }

    const open = text[i + 1];
    const close = open === "(" ? ")" : "}";
    let depth = 0;

    for (let j = i + 1; j < end; j++) {
        const c = text[j];

        if (c === "\\") {
            j++;
        } else if (c === "'") {
            const q = text.indexOf("'", j + 1);

            if (q === -1 || q >= end) {
                return end;
            }

            j = q;
        } else if (c === '"') {
            j = closingQuote(text, j, end);
        } else if (c === open) {
            depth++;
        } else if (c === close && --depth === 0) {
            return j + 1;
        }
    }

    return end;
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
//
// A `$(…)` that starts a statement runs its output as the command, so it stays in the outer text as one
// word: `$` and then `_` on its first line, from the opening quote of the word that holds it, which `raw`
// (the text `cleaned` was cleaned from) shows. The statement is not dropped as empty, so the next one does
// not look adjacent to the one before; a path glued to it stays in the word (`$(npm bin)/biome`); and a
// statement starts before the quote, where a corrected command inserts text.
export function splitSubstitutions(cleaned: string, base = 0, raw = cleaned): Span[] {
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
            const marked = two === "$(" && startsStatement(outer);
            outer += blankKeepingNewlines(cleaned.slice(i, Math.min(j, cleaned.length) + 1));

            if (marked) {
                let from = i;

                while (from > 0 && /[ \t]/.test(outer[from - 1]) && /\S/.test(raw[from - 1] ?? " ")) {
                    from--;
                }

                outer =
                    outer.slice(0, from) +
                    outer.slice(from).replace(/^[^\n]*/, (line) => `$${"_".repeat(line.length - 1)}`);
            }

            units.push(...splitSubstitutions(inner, base + i + 2, raw.slice(i + 2, j)));
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

// Whether cleaned text ending in `text` is at the start of a statement or a pipeline element.
function startsStatement(text: string): boolean {
    let k = text.length - 1;

    while (k >= 0 && (text[k] === " " || text[k] === "\t")) {
        k--;
    }

    return k < 0 || ";&|\n({".includes(text[k]);
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

const SIMPLE_COMMAND_SEPARATOR = new RegExp(`${STATEMENT_SEPARATOR.source}|\\|&?`, "g");

/** Select the last outer simple command on the first shell line, retaining quoted executable and argument text. */
export function lastSimpleCommandOnLine(command: string): string {
    const line = command.split("\n")[0] ?? "";
    const outer = splitSubstitutions(stripShellNoise(line))[0]?.text ?? "";
    let start = 0;
    let last = "";
    const remember = (end: number) => {
        // Use untrimmed syntax boundaries: a quoted launcher or even the whole command can be blank in the mask.
        const text = line.slice(start, end).trim();
        if (text && !text.startsWith("#")) {
            last = text;
        }
    };

    for (const separator of outer.matchAll(SIMPLE_COMMAND_SEPARATOR)) {
        remember(separator.index);
        start = separator.index + separator[0].length;
    }

    remember(line.length);
    return last;
}

const EXECUTABLE_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const MAX_EXECUTABLE_BODY_DEPTH = 4;

// Backticks inside a `#` comment or a quoted-delimiter heredoc body are data, so they are
// skipped. An unquoted heredoc (`cat <<EOF`) still runs its backticks, and so does any body
// a shell reads (`bash <<'EOF'`), so those stay in the scan.
function backtickBodies(source: string, base: number): ExecutableBody[] {
    const bodies: ExecutableBody[] = [];
    let quote: "'" | '"' | null = null;
    let literalHeredoc: PendingHeredoc | null = null;
    let i = 0;

    while (i < source.length) {
        const ch = source[i];
        if (ch === "\\") {
            i += 2;
            continue;
        }
        if (ch === "\n" && quote === null && literalHeredoc) {
            i = consumeHeredocBody(source, i + 1, literalHeredoc, " ").end;
            literalHeredoc = null;
            continue;
        }
        if (ch === "#" && quote === null && (i === 0 || /[\s;&|]/.test(source[i - 1]))) {
            const eol = source.indexOf("\n", i);
            i = eol === -1 ? source.length : eol;
            continue;
        }
        if (ch === "<" && quote === null && source[i + 1] === "<" && source[i + 2] !== "<") {
            const op = HEREDOC_OP.exec(source.slice(i));
            if (op) {
                const lineStart = source.lastIndexOf("\n", i - 1) + 1;
                if (op[2] !== "" && !SHELL_FED.test(source.slice(lineStart, i))) {
                    literalHeredoc = {
                        delim: op[3],
                        stripTabs: op[1] === "-",
                        shellFed: false,
                        opener: i,
                        quoted: true,
                    };
                }

                i += op[0].length;
                continue;
            }
        }
        if (ch === "'" && quote !== '"') {
            quote = quote === "'" ? null : "'";
            i++;
            continue;
        }
        if (ch === '"' && quote !== "'") {
            quote = quote === '"' ? null : '"';
            i++;
            continue;
        }
        if (ch !== "`" || quote === "'") {
            i++;
            continue;
        }

        let end = i + 1;
        while (end < source.length) {
            if (source[end] === "\\") {
                end += 2;
                continue;
            }
            if (source[end] === "`") {
                break;
            }
            end++;
        }

        const bodyEnd = Math.min(end, source.length);
        bodies.push({ text: source.slice(i + 1, bodyEnd), start: base + i + 1, end: base + bodyEnd });
        i = end < source.length ? end + 1 : source.length;
    }

    return bodies;
}

function rawArgumentBody(source: string, from: number, base: number): ExecutableBody | null {
    let start = from;
    while (start < source.length && /\s/.test(source[start])) {
        start++;
    }
    if (start >= source.length) {
        return null;
    }

    const quote = source[start];
    if (quote === "'" || quote === '"') {
        let end = start + 1;
        while (end < source.length) {
            if (quote === '"' && source[end] === "\\") {
                end += 2;
                continue;
            }
            if (source[end] === quote) {
                return {
                    text: source.slice(start + 1, end),
                    start: base + start + 1,
                    end: base + end,
                };
            }
            end++;
        }

        return { text: source.slice(start + 1), start: base + start + 1, end: base + source.length };
    }

    let end = start;
    while (end < source.length && !/\s|[;&|]/.test(source[end])) {
        end++;
    }
    return { text: source.slice(start, end), start: base + start, end: base + end };
}

function shellCommandBodies(source: string, base: number): ExecutableBody[] {
    const cleaned = stripShellNoise(source);
    const bodies: ExecutableBody[] = [];

    for (const unit of splitSubstitutions(cleaned, base, source)) {
        for (const statement of splitStatements(unit)) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const commandIndex = commandTokenIndex(tokens);
                if (commandIndex < 0 || !EXECUTABLE_SHELLS.has(commandWord(tokens[commandIndex].text))) {
                    continue;
                }

                const commandOption = tokens
                    .slice(commandIndex + 1)
                    .find((token) => token.text === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(token.text));
                if (!commandOption) {
                    continue;
                }

                const localEnd = commandOption.start - base + commandOption.text.length;
                const body = rawArgumentBody(source, localEnd, base);
                if (body) {
                    bodies.push(body);
                }
            }
        }
    }

    return bodies;
}

function executableBodies(source: string, base = 0, depth = 0, seen = new Set<string>()): ExecutableBody[] {
    if (depth >= MAX_EXECUTABLE_BODY_DEPTH) {
        return [];
    }

    const direct = [...backtickBodies(source, base), ...shellCommandBodies(source, base)];
    const bodies: ExecutableBody[] = [];
    for (const body of direct) {
        const key = `${body.start}:${body.end}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        bodies.push(body, ...executableBodies(body.text, body.start, depth + 1, seen));
    }

    return bodies;
}

// Everything a rule needs, computed once per command.
export interface ShellScan {
    command: string;
    cleaned: string;
    /** The outer command and each command substitution, as statement lists. */
    units: Span[][];
    /** Bounds of quoted/backtick bodies that are executable, used to keep violation excerpts inside the body. */
    executableRanges: Array<{ start: number; end: number }>;
    /** The heredoc bodies a shell reads, in the command and in its executable bodies. */
    heredocs: ShellHeredoc[];
    /** The folder the command runs in, from the hook payload; absent when the caller did not say. */
    cwd?: string;
}

export function scanShell(command: string, cwd?: string): ShellScan {
    const heredocs: ShellHeredoc[] = [];
    const cleaned = scanCode(command, 0, false, " ", { list: heredocs, base: 0 }).text;
    const bodies = executableBodies(command);
    const units = [
        ...splitSubstitutions(cleaned, 0, command).map((unit) => splitStatements(unit)),
        ...bodies.flatMap((body) =>
            splitSubstitutions(
                cleanedBody(command, body, " ", heredocs),
                body.start,
                command.slice(body.start, body.end)
            ).map((unit) => splitStatements(unit))
        ),
    ];
    return {
        command,
        cleaned,
        units,
        executableRanges: bodies.map(({ start, end }) => ({ start, end })),
        // A `$(…)` in a double-quoted body is scanned with the command and again with the body.
        heredocs: heredocs.filter((heredoc, k) => heredocs.findIndex((h) => h.opener === heredoc.opener) === k),
        ...(cwd ? { cwd } : {}),
    };
}
