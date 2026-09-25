import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ShellScan } from "@genesiscz/utils/shell/scan";

export interface Word {
    value: string;
    /** Contains an expansion (`$x`, `$(...)`, a backtick) the text alone cannot resolve. */
    dynamic: boolean;
    /** A redirection operator (`>`, `>>`, `2>`, `&>`, `<`, `<<`), whose target is the next word. */
    op?: string;
}

const REDIRECT = /^(\d*|&)(>>|>\||>&|>|<<<|<<-?|<&|<>|<)/;

/**
 * Split one simple command into shell words the way the shell would, without running it:
 * quotes are removed, backslashes escape, and an expansion marks the word `dynamic` so a guess
 * is never mistaken for a path. Redirection operators come out as their own words.
 */
export function shellWords(input: string): Word[] {
    const words: Word[] = [];
    let i = 0;

    while (i < input.length) {
        while (i < input.length && /\s/.test(input[i] ?? "")) {
            i++;
        }

        if (i >= input.length) {
            break;
        }

        const op = REDIRECT.exec(input.slice(i));

        if (op) {
            words.push({ value: "", dynamic: false, op: `${op[1]}${op[2]}` });
            i += op[0].length;
            continue;
        }

        let value = "";
        let dynamic = false;

        while (i < input.length && !/\s/.test(input[i] ?? "")) {
            const ch = input[i] ?? "";

            if (ch === "\\") {
                value += input[i + 1] ?? "";
                i += 2;
                continue;
            }

            if (ch === "'") {
                const end = input.indexOf("'", i + 1);
                const stop = end === -1 ? input.length : end;
                value += input.slice(i + 1, stop);
                i = stop + 1;
                continue;
            }

            if (ch === '"') {
                i++;

                while (i < input.length && input[i] !== '"') {
                    if (input[i] === "\\" && /["\\$`]/.test(input[i + 1] ?? "")) {
                        value += input[i + 1];
                        i += 2;
                        continue;
                    }

                    if (input[i] === "$" || input[i] === "`") {
                        dynamic = true;
                    }

                    value += input[i];
                    i++;
                }

                i++;
                continue;
            }

            // A command substitution is one opaque part of the word, however many spaces it holds.
            if (ch === "$" && input[i + 1] === "(") {
                const end = closingParen(input, i + 1);
                value += input.slice(i, end + 1);
                dynamic = true;
                i = end + 1;
                continue;
            }

            // An expansion, or a glob the shell would expand into other names.
            if (ch === "$" || ch === "`" || ch === "*" || ch === "?" || ch === "[") {
                dynamic = true;
            }

            // A redirection glued to the word ends it (`echo hi>out.txt`), an arrow (`a->b`, `x=>y`) does not.
            if ((ch === ">" || ch === "<") && value.length > 0 && !/[-=]$/.test(value)) {
                break;
            }

            value += ch;
            i++;
        }

        words.push({ value, dynamic });
    }

    return words;
}

/** Index of the `)` that closes the `(` at `open`, skipping quoted text; the input's end when unbalanced. */
function closingParen(input: string, open: number): number {
    let depth = 0;

    for (let i = open; i < input.length; i++) {
        const ch = input[i];

        if (ch === "'" || ch === '"') {
            const end = input.indexOf(ch, i + 1);
            i = end === -1 ? input.length : end;
            continue;
        }

        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;

            if (depth === 0) {
                return i;
            }
        }
    }

    return input.length - 1;
}

export function expandHome(value: string): string {
    if (value === "~") {
        return homedir();
    }

    return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}

/**
 * One pipeline element as typed. The cleaned span ends where the scanner blanked a quoted last
 * argument, so the slice runs on through blanks, but never past the end of the line: a heredoc
 * body is blanked too, and reading on through it would parse the body (Python, a spec) as
 * shell words.
 */
export function elementText(scanned: ShellScan, start: number, cleanedEnd: number): string {
    let end = cleanedEnd;

    while (
        end < scanned.cleaned.length &&
        (scanned.cleaned[end] === " " || scanned.cleaned[end] === "\t") &&
        scanned.command[end] !== "\n"
    ) {
        end++;
    }

    return scanned.command.slice(start, end).trimEnd();
}

const VARIABLE_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
/** A loop over more names than this is not expanded: its targets are treated as unknown. */
const MAX_EXPANSIONS = 64;

/**
 * Every value `raw` takes once its `$NAME` references are replaced by what the command itself
 * assigned (`F=x`, or each item of `for F in a b`), or null when it holds anything else: an
 * unknown variable, a command substitution, a glob.
 */
export function expandVariables(raw: string, vars: ReadonlyMap<string, readonly string[]>): string[] | null {
    if (/\$\(|`|[*?[]/.test(raw)) {
        return null;
    }

    let values = [raw];

    for (const match of raw.matchAll(VARIABLE_REF)) {
        const known = vars.get(match[1] ?? "");

        if (!known || known.length === 0) {
            return null;
        }

        values = values.flatMap((value) => known.map((item) => value.replace(match[0], item)));

        if (values.length > MAX_EXPANSIONS) {
            return null;
        }
    }

    return /\$/.test(values.join("")) ? null : values;
}

/**
 * The body of the heredoc whose operator sits on the line starting at `from`: every line after
 * that line up to the one that is exactly the delimiter (tab-stripped for `<<-`). A heredoc with
 * no terminator runs to the end of the command.
 */
export function heredocBody(input: {
    command: string;
    from: number;
    delimiter: string;
    stripTabs?: boolean;
}): string | null {
    const lineEnd = input.command.indexOf("\n", input.from);

    if (lineEnd === -1 || input.delimiter.length === 0) {
        return null;
    }

    const body: string[] = [];

    for (const line of input.command.slice(lineEnd + 1).split("\n")) {
        const candidate = input.stripTabs ? line.replace(/^\t+/, "") : line;

        if (candidate === input.delimiter) {
            break;
        }

        body.push(line);
    }

    return body.join("\n");
}
