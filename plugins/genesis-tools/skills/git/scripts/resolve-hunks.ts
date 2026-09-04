#!/usr/bin/env bun
/**
 * Resolve every conflict block in ONE file to a side, flipping listed hunks.
 *
 *     resolve-hunks.ts <file> theirs|ours [hunk-index ...]
 *
 * `ours` is the side before `=======` (HEAD), `theirs` the side after it. Hunk indices
 * are 1-based in file order; each listed index takes the other side. Only the text
 * between `<<<<<<<` and `>>>>>>>` changes, so the already-merged non-conflict regions
 * survive untouched. Refuses to write if any marker would remain. Language-agnostic.
 *
 * Used by the gt:git skill, references/oracle-merge.md step 3. A whole-file
 * `git show <side>:<file> > <file>` is NOT equivalent: it throws away the other side's
 * work in every non-conflict region.
 *
 * Exit codes: 0 written · 1 nothing written (no blocks, bad flip index, markers would
 * remain) · 2 usage.
 */

import { readFileSync, writeFileSync } from "node:fs";

type Side = "ours" | "theirs";

const USAGE = "usage: resolve-hunks.ts <file> theirs|ours [hunk-index ...]\n";

function other(side: Side): Side {
    return side === "ours" ? "theirs" : "ours";
}

export function resolveHunks(source: string, defaultSide: Side, flip: Set<number>): { text: string; hunks: number } {
    // diff3 and zdiff3 insert a `||||||| <label>` base section between ours and `=======`; it belongs to neither side.
    // Git writes the markers with the file's own endings, so CRLF must match, and a conflict whose
    // closing marker is the last byte of the file has no newline after it.
    // Every marker is anchored with `^` under /m: git only writes them at a line start, and without
    // the anchor a source line holding `"|||||||"` opens a base section that swallows the rest of ours.
    const block =
        /^<<<<<<< [^\r\n]*\r?\n([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\r\n]*\r?\n[\s\S]*?)?^=======\r?\n([\s\S]*?)^>>>>>>> [^\r\n]*(?:\r?\n|$)/gm;
    let seen = 0;

    const text = source.replace(block, (_match, ours: string, theirs: string) => {
        seen += 1;
        const side = flip.has(seen) ? other(defaultSide) : defaultSide;
        return side === "ours" ? ours : theirs;
    });

    return { text, hunks: seen };
}

function main(argv: string[]): number {
    const [path, sideArg, ...flipArgs] = argv;

    if (!path || (sideArg !== "ours" && sideArg !== "theirs")) {
        process.stderr.write(USAGE);
        return 2;
    }

    const flip = new Set<number>();

    for (const raw of flipArgs) {
        const n = Number(raw);

        if (!Number.isInteger(n) || n < 1) {
            process.stderr.write(`${path}: hunk index must be a positive integer, got "${raw}"\n`);
            return 2;
        }

        flip.add(n);
    }

    const source = readFileSync(path, "utf8");
    const { text, hunks } = resolveHunks(source, sideArg, flip);

    if (hunks === 0) {
        process.stderr.write(`${path}: no conflict blocks found\n`);
        return 1;
    }

    if (text.includes("<<<<<<<") || text.includes("|||||||") || text.includes(">>>>>>>")) {
        process.stderr.write(`${path}: markers would remain, nothing written\n`);
        return 1;
    }

    const unknown = [...flip].filter((i) => i > hunks).sort((a, b) => a - b);

    if (unknown.length > 0) {
        process.stderr.write(`${path}: only ${hunks} hunk(s), cannot flip [${unknown.join(", ")}]; nothing written\n`);
        return 1;
    }

    writeFileSync(path, text);
    const flipped = flip.size > 0 ? `, flipped [${[...flip].sort((a, b) => a - b).join(", ")}]` : "";
    process.stdout.write(`${path}: ${hunks} hunk(s) -> ${sideArg}${flipped}\n`);
    return 0;
}

if (import.meta.main) {
    process.exit(main(process.argv.slice(2)));
}
