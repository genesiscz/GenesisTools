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

import {
    commandTokenIndex,
    commandWord,
    originalSlice,
    type ShellScan,
    type Span,
    splitPipeline,
    tokenize,
} from "../scan";
import { wordsFrom } from "./find";
import type { ShellMatch, ShellRule } from "./types";

/** Runners that start the next word as the command: `bunx biome`, `npx biome`, `pnpm biome`. */
const RUNNERS = new Set(["bunx", "npx", "pnpx", "pnpm", "yarn"]);
const EXEC_RUNNERS = new Set(["yarn", "pnpm", "npm"]);
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

    if (RUNNERS.has(word) && BIOME.has(commandWord(args[0] ?? ""))) {
        return 0;
    }

    if (EXEC_RUNNERS.has(word) && args[0] === "exec") {
        const index = args[1] === "--" ? 2 : 1;
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
                return wordsFrom(scan, flag.start + flag.text.length, 1);
            }

            return flag.text.startsWith(`${option}=`)
                ? wordsFrom(scan, flag.start, 1).map((word) => word.slice(option.length + 1))
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

        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("biome")) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens, scan.command);

                    if (cmd === -1) {
                        continue;
                    }

                    // A scanned token ends at a glued `;` or `|` already, but not at a glued redirection.
                    const cut = (token: Span) => ({ ...token, text: token.text.split(/[<>]/)[0] });
                    const flags = tokens.slice(cmd + 1).map(cut);
                    const args = flags.map((flag) => flag.text);

                    if (biomeIndex(commandWord(tokens[cmd].text), args) === -2) {
                        continue;
                    }

                    const fix = correction(scan, flags);

                    if (!fix) {
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
