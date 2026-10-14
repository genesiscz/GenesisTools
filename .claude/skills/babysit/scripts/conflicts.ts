#!/usr/bin/env bun
/**
 * Resolve git conflict blocks and check the result, so no conflict in the babysit flow is resolved by an inline
 * script again. On 2026-10-14 an inline resolver returned any string pick as the replacement text, so the picks
 * ["ours", "ours"] wrote the word `ours` into both plugin manifests (d9687720a); nothing parsed them, and the
 * genesis-tools plugin did not load in any new session for 12 hours. Here a pick is a side (`{ side: "ours" }`) or
 * explicit text (`{ text: "…" }`), never a bare string, and every resolution is checked before it is written.
 *
 *   bun conflicts.ts resolve <file> <ours|theirs|both|base> [...]   # one side per conflict block, in file order
 *   bun conflicts.ts check <file> [...]                             # no conflict marker left, and JSON files parse
 *
 * Paths are relative to the current folder (the worktree). For text no side gives, edit the file, then run `check`.
 * `base` needs the diff3 form: `git checkout --conflict=diff3 -- <file>` recreates it. Exit 0 when every file is clean,
 * 1 naming each problem, 2 on a usage error.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { jsonProblem } from "../../../../scripts/ci/check-json";

export type ConflictSide = "ours" | "theirs" | "both" | "base";
export type ConflictPick = { side: ConflictSide } | { text: string };

const SIDES: readonly ConflictSide[] = ["ours", "theirs", "both", "base"];

function isSide(word: string): word is ConflictSide {
    return SIDES.some((side) => side === word);
}
const START = /^<{7}(?:\s|$)/;
const BASE = /^\|{7}(?:\s|$)/;
const MIDDLE = /^={7}\s*$/;
const END = /^>{7}(?:\s|$)/;

interface Block {
    ours: string[];
    base: string[] | null;
    theirs: string[];
    section: "ours" | "base" | "theirs";
}

function chosen(block: Block, pick: ConflictPick, number: number): string {
    if (typeof pick !== "object" || pick === null) {
        throw new Error(`pick ${number} is ${typeof pick}: a pick is { side } or { text }, never a bare string`);
    }

    if ("text" in pick) {
        return pick.text;
    }

    switch (pick.side) {
        case "ours":
            return block.ours.join("");
        case "theirs":
            return block.theirs.join("");
        case "both":
            return block.ours.join("") + block.theirs.join("");
        case "base":
            if (block.base === null) {
                throw new Error(
                    `conflict block ${number} has no base section (git checkout --conflict=diff3 -- <file>)`
                );
            }

            return block.base.join("");
        default:
            throw new Error(`pick ${number} names no side: ${String(pick.side)}`);
    }
}

/** The text with each conflict block replaced by its pick, in file order. Throws unless every block is closed and
 * there is exactly one pick per block. */
export function resolveConflictText(text: string, picks: ConflictPick[]): string {
    const out: string[] = [];
    let block: Block | null = null;
    let count = 0;

    for (const line of text.split(/(?<=\n)/)) {
        if (!block) {
            if (START.test(line)) {
                block = { ours: [], base: null, theirs: [], section: "ours" };
            } else {
                out.push(line);
            }

            continue;
        }

        if (block.section === "ours" && BASE.test(line)) {
            block.base = [];
            block.section = "base";
            continue;
        }

        if (block.section !== "theirs" && MIDDLE.test(line)) {
            block.section = "theirs";
            continue;
        }

        if (block.section === "theirs" && END.test(line)) {
            count++;
            const pick = picks[count - 1];

            if (pick === undefined) {
                throw new Error(`conflict block ${count} has no pick (${picks.length} given)`);
            }

            out.push(chosen(block, pick, count));
            block = null;
            continue;
        }

        if (block.section === "base") {
            block.base?.push(line);
        } else {
            block[block.section].push(line);
        }
    }

    if (block) {
        throw new Error(`conflict block ${count + 1} is not closed`);
    }

    if (count !== picks.length) {
        throw new Error(`${picks.length} pick(s) for ${count} conflict block(s)`);
    }

    return out.join("");
}

/** 1-based numbers of the lines that still start or end a conflict block. */
export function markerLines(text: string): number[] {
    return text.split("\n").flatMap((line, index) => (START.test(line) || END.test(line) ? [index + 1] : []));
}

/** What is wrong with each resolved file: a conflict marker left in it, or JSON that does not parse. */
export function resolutionProblems(files: string[], read: (file: string) => string): string[] {
    return files.flatMap((file) => {
        const text = read(file);
        const problems = markerLines(text).map((line) => `${file}:${line}: conflict marker left`);
        const json = /\.jsonc?$/.test(file) ? jsonProblem(file, text) : null;
        return json ? [...problems, `${file}: ${json}`] : problems;
    });
}

function fail(problems: string[]): never {
    for (const problem of problems) {
        console.error(`✖ ${problem}`);
    }

    process.exit(1);
}

function main(): void {
    const [command, ...rest] = process.argv.slice(2);
    const read = (file: string) => readFileSync(file, "utf8");

    if (command === "resolve" && rest.length >= 2) {
        const [file = "", ...sides] = rest;

        const picks = sides.filter(isSide).map((side) => ({ side }));

        if (picks.length !== sides.length) {
            console.error(`✖ a pick is one of ${SIDES.join(", ")}; for other text edit ${file}, then run check`);
            process.exit(2);
        }

        let resolved = "";

        try {
            resolved = resolveConflictText(read(file), picks);
        } catch (error) {
            fail([`${file}: ${error instanceof Error ? error.message : String(error)}`]);
        }

        const problems = resolutionProblems([file], () => resolved);

        if (problems.length > 0) {
            fail([...problems, `${file} left as it was`]);
        }

        writeFileSync(file, resolved);
        console.log(`✔ ${file}: ${sides.length} block(s) resolved; stage it with git add -- ${file}`);
        return;
    }

    if (command === "check" && rest.length > 0) {
        const missing = rest.filter((file) => !existsSync(file)).map((file) => `${file}: not found`);
        const problems = [...missing, ...resolutionProblems(rest.filter(existsSync), read)];

        if (problems.length > 0) {
            fail(problems);
        }

        console.log(`✔ ${rest.length} file(s): no conflict marker, JSON parses`);
        return;
    }

    console.error("usage: conflicts.ts resolve <file> <ours|theirs|both|base> [...] | check <file> [...]");
    process.exit(2);
}

if (import.meta.main) {
    main();
}
