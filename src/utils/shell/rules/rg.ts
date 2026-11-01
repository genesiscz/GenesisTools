// ripgrep short-flag clusters that contain `r`.
//
// In ripgrep `-r` is `--replace=TEXT`, and ripgrep is already recursive. So
// `rg -rn pat` is `rg --replace n pat`: every match is rewritten to the literal
// "n", no line numbers, no error. `rg -nr pat` ends the cluster on r, so the
// NEXT argument (the pattern) becomes the replacement text.

import {
    commandTokenIndex,
    commandWord,
    nextRawArgument,
    type ShellScan,
    type Span,
    splitPipeline,
    tokenize,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

// A single-dash cluster of two or more letters containing `r`: -rn, -rl, -nr,
// -ri … A bare `-r TEXT` is the real --replace short form and is left alone:
// the corpus shows it used on purpose (`-o 'x(\d+)' -r '$1'`), and so is a
// cluster that combines -o with a trailing -r (`-or '$1'`): only-matching plus
// replace is the capture-group idiom, and it takes the next argument on purpose.
const RG_REPLACE_BUNDLE = /^-(?=[A-Za-z]*r)[A-Za-z]{2,}$/;
const RG_ONLY_MATCHING_REPLACE = /^-[A-Za-z]*o[A-Za-z]*r$/;
// Short flags that take the REST of the cluster as their value: in `-tmarkdown` the
// `r` belongs to the type name, so there is no --replace in it at all.
const RG_VALUE_FLAGS = new Set(["A", "B", "C", "d", "e", "E", "f", "g", "j", "m", "M", "t", "T"]);
/** ripgrep long flags that take the next argument as their value. */
export const RG_LONG_VALUE_FLAGS: ReadonlySet<string> = new Set([
    "--after-context",
    "--before-context",
    "--context",
    "--max-depth",
    "--encoding",
    "--regexp",
    "--file",
    "--glob",
    "--iglob",
    "--threads",
    "--max-columns",
    "--max-count",
    "--type",
    "--type-not",
    "--type-add",
    "--sort",
    "--sortr",
    "--color",
    "--colors",
    "--max-filesize",
    "--pre",
    "--pre-glob",
    "--ignore-file",
    "--engine",
    "--path-separator",
    "--context-separator",
    "--field-context-separator",
    "--field-match-separator",
    "--hyperlink-format",
    "--replace",
    "--type-clear",
]);
// Output modes that print paths, counts or nothing instead of match text, so a replacement
// never shows. Not -L: in ripgrep that is --follow.
const RG_NO_MATCH_TEXT = new Set([
    "--files-with-matches",
    "--files-without-match",
    "--count",
    "--count-matches",
    "--quiet",
    "--files",
]);
const RG_NO_MATCH_TEXT_LETTERS = new Set(["l", "c", "q"]);

/** Where the argument after `token` ends in the original command. A quoted value leaves no token of its own. */
function valueEnd(command: string, token: Span): number {
    const from = token.start + token.text.length;
    const value = nextRawArgument(command, from);
    return value === null ? from : command.indexOf(value, from) + value.length;
}

/**
 * Whether this rg call prints no match text (-l, -c, -q, --files …), so the replacement of the
 * cluster at `cluster` cannot show. Inside that cluster only the letters before the r are flags.
 */
function printsNoMatchText(command: string, tokens: Span[], cmd: number, cluster: number, rAt: number): boolean {
    if ([...tokens[cluster].text.slice(1, rAt)].some((letter) => RG_NO_MATCH_TEXT_LETTERS.has(letter))) {
        return true;
    }

    let skipBefore = -1;

    for (let i = cmd + 1; i < tokens.length; i++) {
        const { text, start } = tokens[i];

        if (i === cluster || start < skipBefore) {
            continue;
        }

        if (text === "--") {
            return false;
        }

        if (text.startsWith("--")) {
            const [flag = ""] = text.split("=", 1);

            if (RG_NO_MATCH_TEXT.has(flag)) {
                return true;
            }

            if (RG_LONG_VALUE_FLAGS.has(flag) && !text.includes("=")) {
                skipBefore = valueEnd(command, tokens[i]);
            }

            continue;
        }

        if (!text.startsWith("-")) {
            continue;
        }

        for (let k = 1; k < text.length; k++) {
            if (RG_NO_MATCH_TEXT_LETTERS.has(text[k])) {
                return true;
            }

            // A second -r (or -or) takes its replacement the same way: `-r -l` replaces with "-l".
            if (RG_VALUE_FLAGS.has(text[k]) || text[k] === "r") {
                if (k === text.length - 1) {
                    skipBefore = valueEnd(command, tokens[i]);
                }

                break;
            }
        }
    }

    return false;
}

/** Where ripgrep reads an `r` in this cluster as --replace, or -1 when a value flag swallows it first. */
function replaceIndex(token: string): number {
    for (let k = 1; k < token.length; k++) {
        if (token[k] === "r") {
            return k;
        }

        if (RG_VALUE_FLAGS.has(token[k])) {
            return -1;
        }
    }

    return -1;
}

export interface RgClusterMatch extends ShellMatch {
    flag: string;
    replacement: string;
}

export function findRgCluster(scan: ShellScan): RgClusterMatch | null {
    for (const statements of scan.units) {
        for (const statement of statements) {
            if (!statement.text.includes("rg")) {
                continue;
            }

            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const cmd = commandTokenIndex(tokens, scan.command);

                if (cmd === -1 || commandWord(tokens[cmd].text) !== "rg") {
                    continue;
                }

                for (let i = cmd + 1; i < tokens.length; i++) {
                    const token = tokens[i].text;

                    if (token === "--") {
                        break;
                    }

                    const rAt = RG_REPLACE_BUNDLE.test(token) ? replaceIndex(token) : -1;

                    if (rAt === -1 || RG_ONLY_MATCHING_REPLACE.test(token)) {
                        continue;
                    }

                    // Letters after the r are the replacement; when r is last, ripgrep
                    // takes the next argument instead.
                    const afterR = token.slice(rAt + 1);

                    // A replacement nobody sees changes nothing. An r last still eats the pattern.
                    if (afterR.length > 0 && printsNoMatchText(scan.command, tokens, cmd, i, rAt)) {
                        continue;
                    }

                    const replacement = afterR.length > 0 ? afterR : (tokens[i + 1]?.text ?? "");
                    const fixed = token.slice(0, rAt) + token.slice(rAt + 1);
                    const start = tokens[i].start;
                    const suggestion = scan.command.slice(0, start) + fixed + scan.command.slice(start + token.length);

                    return {
                        flag: token,
                        replacement,
                        matched: scan.command.slice(start, start + token.length),
                        index: start,
                        suggestion,
                    };
                }
            }
        }
    }

    return null;
}

export const rgReplaceCluster: ShellRule = {
    id: "rg-replace-cluster",
    kind: "misread",
    title: "rg short-flag cluster with r: -r is --replace, not recursive",
    severity: "block",
    why:
        "ripgrep is recursive by default and its -r means --replace=TEXT. In a cluster like -rn the letters " +
        'after the r become the replacement text, so every match is printed as the literal "n" with no ' +
        "line numbers and no error; in -nr the pattern itself becomes the replacement. The output looks " +
        'mangled and reads as "the file contains n".',
    wrong: "rg -rn 'setSavedToken' packages",
    right: "rg -n 'setSavedToken' packages   # -r only when you mean --replace, spelled out",
    evidence:
        "592 calls in 90 days, 32 sampled, none legitimate; a bare `-r '$1'` after `-o` is exempt, and so is a " +
        "cluster such as -rn in a call that prints only paths, counts or nothing (-l, -c, -q, --files).",
    detect(scan) {
        const hit = findRgCluster(scan);
        return hit ? { matched: hit.matched, index: hit.index, suggestion: hit.suggestion } : null;
    },
};

export const rgRules: readonly ShellRule[] = [rgReplaceCluster];
