// ripgrep short-flag clusters that contain `r`.
//
// In ripgrep `-r` is `--replace=TEXT`, and ripgrep is already recursive. So
// `rg -rn pat` is `rg --replace n pat`: every match is rewritten to the literal
// "n", no line numbers, no error. `rg -nr pat` ends the cluster on r, so the
// NEXT argument (the pattern) becomes the replacement text.

import { commandTokenIndex, commandWord, type ShellScan, splitPipeline, tokenize } from "../scan";
import type { ShellMatch, ShellRule } from "./types";

// A single-dash cluster of two or more letters containing `r`: -rn, -rl, -nr,
// -ri … A bare `-r TEXT` is the real --replace short form and is left alone:
// the corpus shows it used on purpose (`-o 'x(\d+)' -r '$1'`), and so is a
// cluster that combines -o with a trailing -r (`-or '$1'`): only-matching plus
// replace is the capture-group idiom, and it takes the next argument on purpose.
const RG_REPLACE_BUNDLE = /^-(?=[A-Za-z]*r)[A-Za-z]{2,}$/;
const RG_ONLY_MATCHING_REPLACE = /^-[A-Za-z]*o[A-Za-z]*r$/;

export interface RgClusterMatch extends ShellMatch {
    flag: string;
    replacement: string;
}

export function findRgCluster(scan: ShellScan): RgClusterMatch | null {
    for (const statements of scan.units) {
        for (const statement of statements) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const cmd = commandTokenIndex(tokens);

                if (cmd === -1 || commandWord(tokens[cmd].text) !== "rg") {
                    continue;
                }

                for (let i = cmd + 1; i < tokens.length; i++) {
                    const token = tokens[i].text;

                    if (token === "--") {
                        break;
                    }

                    if (!RG_REPLACE_BUNDLE.test(token) || RG_ONLY_MATCHING_REPLACE.test(token)) {
                        continue;
                    }

                    // Letters after the r are the replacement; when r is last, ripgrep
                    // takes the next argument instead.
                    const afterR = token.slice(token.indexOf("r") + 1);
                    const replacement = afterR.length > 0 ? afterR : (tokens[i + 1]?.text ?? "");
                    const fixed = token.replace("r", "");
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
    evidence: "592 calls in 90 days, 32 sampled, none legitimate; a bare `-r '$1'` after `-o` is exempt.",
    detect(scan) {
        const hit = findRgCluster(scan);
        return hit ? { matched: hit.matched, index: hit.index, suggestion: hit.suggestion } : null;
    },
};

export const rgRules: readonly ShellRule[] = [rgReplaceCluster];
