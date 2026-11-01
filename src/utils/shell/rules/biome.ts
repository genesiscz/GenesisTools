// `biome lint|check --write --unsafe` (or `--fix --unsafe`, or 1.x `--apply-unsafe`).
//
// The unsafe fix for `noUnusedImports` deletes the import together with the comment
// attached above it, and that comment is often the file's header. Nothing in the
// output says a comment went: Biome reports "Fixed N files". On 2026-10-14 a sweep run
// with `--only=correctness/noUnusedImports --write --unsafe` deleted the 27-line header
// of a benchmark script and a 12-line header of another; only a review of the diff
// caught it. On Biome 2.5.11, `--skip=correctness/noUnusedImports` keeps the header and
// still applies every other unsafe fix (useBlockStatements has no safe one), so that is
// the corrected form, and an --only that leaves noUnusedImports out is no risk at all.
// When --only names noUnusedImports itself, the safe run lists the imports instead and
// each is removed by hand.
//
// On Biome 2.5.11 the loss reaches every comment above the last import, also across empty
// lines (two adjacent imports removed take a header that an empty line parts from them), and
// any comment inside or behind an import on its lines. A comment below the last import stays.
// When the command names every target as a plain script file, the rule reads them and stays
// quiet when none has a comment before the end of its last import.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
    commandTokenIndex,
    commandWord,
    originalSlice,
    type ShellScan,
    type Span,
    splitPipeline,
    tokenize,
    wordsFrom,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

/** Runners that start the next word as the command: `bunx biome`, `npx biome`, `pnpm biome`. */
const RUNNERS = new Set(["bunx", "npx", "pnpx", "pnpm", "yarn"]);
const EXEC_RUNNERS = new Set(["yarn", "pnpm", "npm"]);
// Runners whose folder the rule does not read targets against: `yarn biome` (1.x) starts biome in the
// package root, `pnpm biome` runs a package script named biome first, and `pnpx biome` downloads the
// npm package `biome`, which is not Biome. `yarn exec` and `pnpm exec` (pnpm 12.3.4) keep the folder.
const ROOT_RUNNERS = new Set(["pnpm", "pnpx", "yarn"]);
// Runner options before `exec` or `biome`; the value flags take the next word. The folder flags start
// biome somewhere else (`pnpm -C dir`, `--filter`, `-r`, `yarn --cwd`, `npm --prefix`).
const RUNNER_VALUE_FLAGS = new Set([
    "-C",
    "--dir",
    "--filter",
    "-F",
    "--cwd",
    "--prefix",
    "-w",
    "--workspace",
    "-p",
    "--package",
]);
const FOLDER_FLAGS = new Set([
    "-C",
    "--dir",
    "--filter",
    "-F",
    "--cwd",
    "--prefix",
    "-w",
    "--workspace",
    "-r",
    "--recursive",
]);
const BIOME = new Set(["biome", "@biomejs/biome"]);
const UNSAFE = new Set(["--unsafe", "--apply-unsafe"]);
// The --only / --skip spellings that select noUnusedImports: the rule itself, and the groups that hold it.
// Biome 2.5.11 rejects a bare `lint`, so naming it there only errors.
const UNUSED_IMPORTS_RULE = new Set([
    "noUnusedImports",
    "correctness/noUnusedImports",
    "lint/correctness/noUnusedImports",
]);
const UNUSED_IMPORTS_GROUP = new Set(["correctness", "lint/correctness", "lint"]);
const SKIP_UNUSED_IMPORTS = "--skip=correctness/noUnusedImports";
// The files biome reads as JavaScript or TypeScript, and the read limits.
const SCRIPT = /\.(?:[mc]?[jt]s|[jt]sx)$/;
const MAX_FILES = 50;
const MAX_BYTES = 1024 * 1024;
// What may run before the runner: literal `cd <dir>` statements, plain assignments, and plain
// assignments in front of it. Anything else could move the folder (`env -C`, `sudo -D`), add
// targets (`xargs`) or write one before biome reads it. Each part matches one way only, so a long
// prefix cannot backtrack.
const PREFIX =
    /^(?:\s*(?:cd[ \t]+(?!-)[^\s;&|()<>$`'"\\{}*?~#]+|[A-Za-z_]\w*=[^\s;&|()<>$`'"\\{}#]*)[ \t]*(?:;|&&|\n))*\s*(?:[A-Za-z_]\w*=[^\s;&|()<>$`'"\\{}#]*[ \t]+)*$/;
// The import keyword, not `import(` or `import.meta`; it starts a declaration after a line end, `;`,
// a brace or `*/`, with only JavaScript whitespace other than a line end between.
const IMPORT = /import(?![\w$]|[ \t]*[(.])/g;
const SPACE = /[^\S\n\r\u2028\u2029]/;
const ATTRIBUTES = /\s*(?:with|assert)\s*\{/y;
const REST_OF_LINE = /.*/y;
const COMMENT = /\/[/*]/;

interface Edit {
    start: number;
    end: number;
    text: string;
}

/** The index of the `biome` word among the args after the command, or -1. */
function biomeIndex(word: string, args: string[]): number {
    if (BIOME.has(word)) {
        return -1;
    }

    let at = 0;

    while ((RUNNERS.has(word) || EXEC_RUNNERS.has(word)) && args[at]?.startsWith("-")) {
        at += RUNNER_VALUE_FLAGS.has(args[at] ?? "") ? 2 : 1;
    }

    if (RUNNERS.has(word) && BIOME.has(commandWord(args[at] ?? ""))) {
        return at;
    }

    if (EXEC_RUNNERS.has(word) && args[at] === "exec") {
        const index = args[at + 1] === "--" ? at + 2 : at + 1;
        if (BIOME.has(commandWord(args[index] ?? ""))) {
            return index;
        }
    }

    // `bun x biome …`
    if (word === "bun" && args[0] === "x" && BIOME.has(commandWord(args[1] ?? ""))) {
        return 1;
    }

    return -2;
}

function selectsUnusedImports(value: string): boolean {
    return UNUSED_IMPORTS_RULE.has(value) || UNUSED_IMPORTS_GROUP.has(value);
}

/**
 * The end of the import whose keyword ends at `from`: past its module string and any `with { … }`
 * clause. -1 when a comment comes first or the statement never ends.
 */
function importEnd(text: string, from: number): number {
    let depth = 0;
    let clause = false;

    for (let i = from; i < text.length; i++) {
        const ch = text[i];

        if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
            return -1;
        }

        if (ch === "{") {
            depth++;
        } else if (ch === "}" && --depth === 0 && clause) {
            return i + 1;
        } else if (ch === '"' || ch === "'") {
            i = text.indexOf(ch, i + 1);

            if (i === -1) {
                return -1;
            }

            if (depth === 0) {
                ATTRIBUTES.lastIndex = i + 1;

                if (!ATTRIBUTES.test(text)) {
                    return i + 1;
                }

                i = ATTRIBUTES.lastIndex - 1;
                depth = 1;
                clause = true;
            }
        }
    }

    return -1;
}

/** Whether `text` has a comment before the end of its last import (a shebang aside), or on that line. */
function importCarriesComment(text: string): boolean {
    let last = -1;

    for (const match of text.matchAll(IMPORT)) {
        let i = match.index;

        while (i > 0 && SPACE.test(text[i - 1])) {
            i--;
        }

        if (i === 0 || "\n\r\u2028\u2029;{}".includes(text[i - 1]) || text.startsWith("*/", i - 2)) {
            last = match.index + match[0].length;
        }
    }

    if (last === -1) {
        return false;
    }

    const start = /^#!.*/.exec(text)?.[0].length ?? 0;
    const end = importEnd(text, last);

    if (COMMENT.test(text.slice(start, last)) || end === -1) {
        return true;
    }

    REST_OF_LINE.lastIndex = end;
    return COMMENT.test(REST_OF_LINE.exec(text)?.[0] ?? "");
}

/**
 * Whether the biome call whose runner starts at `start` names only script files, every one readable,
 * none with a comment the fix could delete. `words` are its arguments after `biome`.
 */
function nothingToDelete(scan: ShellScan, start: number, words: string[]): boolean {
    const prefix = scan.command.slice(0, start);

    if (!PREFIX.test(prefix)) {
        return false;
    }

    let folder = scan.cwd ?? null;

    for (const [, dir] of prefix.matchAll(/(?:^|[;&\n])\s*cd[ \t]+([^\s;&]+)/g)) {
        folder = isAbsolute(dir) ? dir : folder && resolve(folder, dir);
    }

    const files: string[] = [];
    let subcommand = false;

    for (let i = 0; i < words.length; i++) {
        const word = words[i];

        if (word === "--only" || word === "--skip") {
            i++;
        } else if (word === "--" || /^--(?:changed|staged)(?:=|$)/.test(word) || /[$`*?[{~(]/.test(word)) {
            return false;
        } else if (/^(?:\d+|&)?[<>]/.test(word)) {
            // A bare `>` or `2>` takes the next word as its file. With none, a zsh `>|` ended the words
            // and hid the targets after it; a `>(…)` file ended them at its `)`.
            if (/[<>]$/.test(word) && (++i === words.length || words[i].includes("("))) {
                return false;
            }
        } else if (!word.startsWith("-")) {
            if (subcommand) {
                const file = isAbsolute(word) ? word : folder && resolve(folder, word);

                if (!file || !SCRIPT.test(file)) {
                    return false;
                }

                files.push(file);
            }

            subcommand = true;
        }
    }

    if (files.length === 0 || files.length > MAX_FILES) {
        return false;
    }

    try {
        return files.every((file) => {
            const stat = statSync(file);
            return stat.isFile() && stat.size <= MAX_BYTES && !importCarriesComment(readFileSync(file, "utf8"));
        });
    } catch {
        return false;
    }
}

/**
 * The edits that make one biome call safe, or null when it is safe already. Option values are read
 * as the shell passes them.
 */
function correction(scan: ShellScan, flags: Span[]): Edit[] | null {
    const unsafe = flags.filter((flag) => UNSAFE.has(flag.text.split("=")[0]));

    if (unsafe.length === 0) {
        return null;
    }

    // `--only X` and `--only=X`, repeated. A quoted value leaves no token of its own.
    const values = (option: string) =>
        flags.flatMap((flag) => {
            if (flag.text === option) {
                return wordsFrom(scan, flag.start + flag.text.length, 1).words;
            }

            return flag.text.startsWith(`${option}=`)
                ? wordsFrom(scan, flag.start, 1).words.map((word) => word.slice(option.length + 1))
                : [];
        });
    const only = values("--only");
    // A value the shell fills in (`--only=$RULE`) can name the rule itself.
    const namesRule = only.some((value) => UNUSED_IMPORTS_RULE.has(value) || /[$`]/.test(value));

    if (
        values("--skip").some(selectsUnusedImports) ||
        (only.length > 0 && !namesRule && !only.some(selectsUnusedImports))
    ) {
        return null;
    }

    // Keep --unsafe for the fixes the run wants, and skip only the one that deletes comments.
    // Biome 1.x's --apply-unsafe predates --skip, so it keeps the safe correction below.
    if (!namesRule && !flags.some((flag) => flag.text.startsWith("--apply-unsafe"))) {
        const last = unsafe[unsafe.length - 1];
        const end = last.start + last.text.length;
        return [{ start: end, end, text: ` ${SKIP_UNUSED_IMPORTS}` }];
    }

    return unsafe.map((flag) => {
        let start = flag.start;

        while (start > 0 && /\s/.test(scan.command[start - 1])) {
            start--;
        }

        // Biome 1.x's legacy option becomes its safe equivalent, retaining any explicit value.
        const text = flag.text.startsWith("--apply-unsafe") ? ` ${flag.text.replace("--apply-unsafe", "--apply")}` : "";
        return { start, end: flag.start + flag.text.length, text };
    });
}

export const biomeUnsafeDeletesComments: ShellRule = {
    id: "biome-unsafe-deletes-comments",
    kind: "destructive",
    title: "biome --write --unsafe deletes the comment above every import it removes",
    severity: "block",
    why:
        "Biome's unsafe fix for noUnusedImports removes the import with its leading comment, which is often the " +
        'file header, and reports only "Fixed N files". Keep --unsafe and add --skip=correctness/noUnusedImports ' +
        "to get every other unsafe fix; when --only names noUnusedImports, run without --unsafe and remove each " +
        "import it lists as unused by hand, keeping the comment above it.",
    wrong: "bunx biome lint --only=correctness/noUnusedImports --write --unsafe src",
    right: "bunx biome lint --only=correctness/noUnusedImports src   # then delete the listed imports by hand",
    evidence:
        "2026-10-14: a path sweep ran the unsafe fix over 98 files; it deleted a 27-line header in " +
        "scripts/benchmarks/ai-usage/poll-duty.ts and a 12-line header in perf-report.ts. A history scan found " +
        "the same loss shape in earlier commits.",
    detect(scan): ShellMatch | null {
        let hit: { matched: string; index: number } | null = null;
        const edits: Edit[] = [];
        // A `$(…)` in a double-quoted `-c` body is scanned with the command and again with the body. Its edits
        // applied twice at the same offsets add the skip twice, or cut the text after a removed flag a second time.
        const handled = new Set<number>();

        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("biome")) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens, scan.command);

                    if (cmd === -1 || handled.has(tokens[cmd].start)) {
                        continue;
                    }

                    handled.add(tokens[cmd].start);

                    // A scanned token ends at a glued `;` or `|` already, but not at a glued redirection.
                    const cut = (token: Span) => ({ ...token, text: token.text.split(/[<>]/)[0] });
                    const flags = tokens.slice(cmd + 1).map(cut);
                    const args = flags.map((flag) => flag.text);

                    const word = commandWord(tokens[cmd].text);
                    const index = biomeIndex(word, args);

                    if (index === -2) {
                        continue;
                    }

                    const fix = correction(scan, flags);
                    const biome = tokens[cmd + 1 + index];
                    const before = args.slice(0, Math.max(index, 0));
                    const inPlace =
                        !before.some((arg) => FOLDER_FLAGS.has(arg.split("=")[0] ?? "")) &&
                        (!ROOT_RUNNERS.has(word) || (EXEC_RUNNERS.has(word) && before.includes("exec")));

                    if (
                        !fix ||
                        (inPlace &&
                            nothingToDelete(
                                scan,
                                tokens[cmd].start,
                                wordsFrom(scan, biome.start + biome.text.length).words
                            ))
                    ) {
                        continue;
                    }

                    hit ??= {
                        matched: originalSlice(scan, tokens[cmd].start, element.start + element.text.length),
                        index: tokens[cmd].start,
                    };
                    edits.push(...fix);
                }
            }
        }

        if (!hit) {
            return null;
        }

        // Every biome call in the command, edited right to left so the earlier offsets still hold:
        // a suggestion that fixed only the first call would trip this rule again on the second.
        let suggestion = scan.command;

        for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
            suggestion = suggestion.slice(0, edit.start) + edit.text + suggestion.slice(edit.end);
        }

        return { ...hit, suggestion };
    },
};

export const biomeRules: readonly ShellRule[] = [biomeUnsafeDeletesComments];
