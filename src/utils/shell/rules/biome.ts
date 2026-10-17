// `biome lint|check --write --unsafe` (or `--fix --unsafe`, or 1.x `--apply-unsafe`).
//
// The unsafe fix for `noUnusedImports` deletes the import together with the comment
// attached above it, and that comment is often the file's header. Nothing in the
// output says a comment went: Biome reports "Fixed N files". On 2026-10-14 a sweep run
// with `--only=correctness/noUnusedImports --write --unsafe` deleted the 27-line header
// of a benchmark script and a 12-line header of another; only a review of the diff
// caught it. The safe fixes never delete comments, so the command without `--unsafe`
// is the corrected form, and an unused import is removed by hand.

import { commandTokenIndex, commandWord, originalSlice, rawToken, splitPipeline, tokenize } from "../scan";
import type { ShellMatch, ShellRule } from "./types";

/** Runners that start the next word as the command: `bunx biome`, `npx biome`, `pnpm biome`. */
const RUNNERS = new Set(["bunx", "npx", "pnpx", "pnpm", "yarn"]);
const EXEC_RUNNERS = new Set(["yarn", "pnpm", "npm"]);
const BIOME = new Set(["biome", "@biomejs/biome"]);
const UNSAFE = new Set(["--unsafe", "--apply-unsafe"]);

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

export const biomeUnsafeDeletesComments: ShellRule = {
    id: "biome-unsafe-deletes-comments",
    kind: "destructive",
    title: "biome --write --unsafe deletes the comment above every import it removes",
    severity: "block",
    why:
        "Biome's unsafe fix for noUnusedImports removes the import with its leading comment, which is often the " +
        'file header, and reports only "Fixed N files". The safe fixes never delete comments. Run the command ' +
        "without --unsafe, then remove each import it lists as unused by hand, keeping the comment above it.",
    wrong: "bunx biome lint --only=correctness/noUnusedImports --write --unsafe src",
    right: "bunx biome lint --only=correctness/noUnusedImports src   # then delete the listed imports by hand",
    evidence:
        "2026-10-14: a path sweep ran the unsafe fix over 98 files; it deleted a 27-line header in " +
        "scripts/benchmarks/ai-usage/poll-duty.ts and a 12-line header in perf-report.ts. A history scan found " +
        "the same loss shape in earlier commits.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("biome")) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens);

                    if (cmd === -1) {
                        continue;
                    }

                    const word = commandWord(tokens[cmd].text);
                    const args = tokens.slice(cmd + 1).map((token) => rawToken(scan.command, token));

                    if (biomeIndex(word, args) === -2) {
                        continue;
                    }

                    const unsafe = args.flatMap((arg, index) => (UNSAFE.has(arg.split("=")[0]) ? [index] : []));

                    if (unsafe.length === 0) {
                        continue;
                    }

                    const matched = originalSlice(scan, tokens[cmd].start, element.start + element.text.length);
                    let suggestion = scan.command;
                    // Edit right to left to retain the original offsets and all unrelated shell text.
                    for (const index of unsafe.toReversed()) {
                        const flag = tokens[cmd + 1 + index];
                        // Biome 1.x's legacy option becomes its safe equivalent, retaining any explicit value.
                        const replacement = args[index].startsWith("--apply-unsafe")
                            ? args[index].replace("--apply-unsafe", "--apply")
                            : "";
                        const before = suggestion.slice(0, flag.start).trimEnd();
                        const after = suggestion.slice(flag.start + flag.text.length);
                        suggestion = replacement ? `${before} ${replacement}${after}` : `${before}${after}`;
                    }

                    return { matched, index: tokens[cmd].start, suggestion };
                }
            }
        }

        return null;
    },
};

export const biomeRules: readonly ShellRule[] = [biomeUnsafeDeletesComments];
