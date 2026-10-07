import { diffArrays } from "diff";

/**
 * How the code a reviewer commented on compares with the MR tip. A label a person or an agent can
 * act on without diffing by eye:
 *
 * - `unchanged`: the file is the same.
 * - `changed at the anchor`: a commented line itself changed or went away; the most likely "already fixed".
 * - `changed nearby`: lines inside the context window changed, the anchor line did not.
 * - `changed elsewhere`: only other parts of the file changed; `tipLine` is where the anchor is now.
 * - `deleted`: the file is not at the tip (a rename is reported by the caller as `renamed`).
 * - `unavailable`: the reviewer's version could not be read (a sha gone after a force push), or the tip's
 *   (a timeout or a 5xx from the files API; not evidence that the file was deleted).
 */
export type DivergenceLabel =
    | "unchanged"
    | "changed at the anchor"
    | "changed nearby"
    | "changed elsewhere"
    | "renamed"
    | "deleted"
    | "unavailable";

export interface Divergence {
    label: DivergenceLabel;
    /** The anchor's line at the tip, or null when it changed or the file is gone. */
    tipLine: number | null;
    /** Where the anchor's code sits at the tip when the line itself changed: just after its nearest unchanged line above. */
    nearLine?: number;
    /** The label as one phrase for a heading: `changed elsewhere (L39 → L44)`, `renamed to src/b.ts`. */
    text: string;
}

export interface DivergenceInput {
    /** The file as the reviewer saw it, or null when it could not be read. */
    reviewer: string[] | null;
    /** The file at the MR tip, or null when it is not there. */
    tip: string[] | null;
    /** 1-based line of the comment in the reviewer's file. */
    anchorLine: number;
    /** Lines on each side of the anchor that count as "nearby". */
    window: number;
    /** Where the file went, when the tip has it under another path. */
    renamedTo?: string;
    /** For a file gone at the tip: where the anchor's line is now (`path:line`), when a search found it. */
    movedTo?: string;
}

/** A changed region in the reviewer's file: removed lines `[start, end]`, or an insertion before `start` (`end = start - 1`). */
interface OldRegion {
    start: number;
    end: number;
}

function changedRegions(
    reviewer: string[],
    tip: string[]
): { regions: OldRegion[]; tipLineOf: (line: number) => number | null; nearTipLineOf: (line: number) => number } {
    const regions: OldRegion[] = [];
    /** For each reviewer line kept unchanged, its line at the tip. */
    const kept = new Map<number, number>();
    let oldLine = 1;
    let newLine = 1;

    for (const part of diffArrays(reviewer, tip)) {
        const count = part.count ?? part.value.length;

        if (part.removed) {
            regions.push({ start: oldLine, end: oldLine + count - 1 });
            oldLine += count;
        } else if (part.added) {
            regions.push({ start: oldLine, end: oldLine - 1 });
            newLine += count;
        } else {
            for (let i = 0; i < count; i++) {
                kept.set(oldLine + i, newLine + i);
            }

            oldLine += count;
            newLine += count;
        }
    }

    const nearTipLineOf = (line: number): number => {
        for (let above = line - 1; above >= 1; above--) {
            const mapped = kept.get(above);

            if (mapped !== undefined) {
                return mapped + 1;
            }
        }

        return 1;
    };

    return { regions, tipLineOf: (line) => kept.get(line) ?? null, nearTipLineOf };
}

function touches(region: OldRegion, from: number, to: number): boolean {
    if (region.end < region.start) {
        // An insertion before `start` sits between `start - 1` and `start`.
        return region.start > from && region.start <= to;
    }

    return region.start <= to && region.end >= from;
}

export function classifyDivergence(input: DivergenceInput): Divergence {
    if (input.reviewer === null) {
        return { label: "unavailable", tipLine: null, text: "unavailable (the reviewer's version could not be read)" };
    }

    if (input.tip === null) {
        return input.renamedTo
            ? { label: "renamed", tipLine: null, text: `renamed to ${input.renamedTo}` }
            : {
                  label: "deleted",
                  tipLine: null,
                  text: input.movedTo
                      ? `deleted at the tip (its line is now at ${input.movedTo})`
                      : "deleted at the tip",
              };
    }

    const { regions, tipLineOf, nearTipLineOf } = changedRegions(input.reviewer, input.tip);
    const tipLine = tipLineOf(input.anchorLine);

    if (regions.length === 0) {
        return { label: "unchanged", tipLine, text: "unchanged" };
    }

    if (tipLine === null || regions.some((region) => touches(region, input.anchorLine, input.anchorLine))) {
        const near = Math.min(nearTipLineOf(input.anchorLine), Math.max(1, input.tip.length));
        const found = locateAnchorText(input.reviewer[input.anchorLine - 1] ?? "", input.tip, near);

        return {
            label: "changed at the anchor",
            tipLine,
            nearLine: found?.line ?? near,
            text: found
                ? `changed at the anchor (${found.exact ? "its line is now" : "closest line"} L${found.line})`
                : "changed at the anchor",
        };
    }

    const from = input.anchorLine - input.window;
    const to = input.anchorLine + input.window;

    if (regions.some((region) => touches(region, from, to))) {
        return { label: "changed nearby", tipLine, text: "changed nearby" };
    }

    const moved = tipLine === input.anchorLine ? "" : ` (L${input.anchorLine} → L${tipLine})`;

    return { label: "changed elsewhere", tipLine, text: `changed elsewhere${moved}` };
}

/** Character bigrams of a line with its whitespace removed, for a similarity score. */
function bigrams(text: string): string[] {
    const plain = text.replace(/\s+/g, "");

    return Array.from({ length: Math.max(0, plain.length - 1) }, (_, i) => plain.slice(i, i + 2));
}

/** Dice coefficient of two lines' bigrams, 0 to 1. */
function similarity(a: string, b: string): number {
    const left = bigrams(a);
    const right = bigrams(b);

    if (left.length === 0 || right.length === 0) {
        return 0;
    }

    const pool = new Map<string, number>();

    for (const gram of right) {
        pool.set(gram, (pool.get(gram) ?? 0) + 1);
    }

    let shared = 0;

    for (const gram of left) {
        const count = pool.get(gram) ?? 0;

        if (count > 0) {
            shared++;
            pool.set(gram, count - 1);
        }
    }

    return (2 * shared) / (left.length + right.length);
}

/**
 * Where the anchor's line sits at the tip when the diff could not map it: the same text nearest to
 * `near`, else the most similar line (at least 0.6), nearest on a tie. Too short a line (`}`, `return;`)
 * matches anywhere, so it is not looked up.
 */
export function locateAnchorText(text: string, tip: string[], near: number): { line: number; exact: boolean } | null {
    const wanted = text.trim();

    if (wanted.replace(/\s+/g, "").length < 8) {
        return null;
    }

    const distance = (line: number): number => Math.abs(line - near);
    const exact = tip.map((line, i) => (line.trim() === wanted ? i + 1 : 0)).filter((line) => line > 0);

    if (exact.length > 0) {
        return { line: exact.sort((a, b) => distance(a) - distance(b))[0], exact: true };
    }

    let best: { line: number; score: number } | null = null;

    tip.forEach((line, i) => {
        const score = similarity(wanted, line);

        if (
            score >= 0.6 &&
            (!best || score > best.score || (score === best.score && distance(i + 1) < distance(best.line)))
        ) {
            best = { line: i + 1, score };
        }
    });

    const found = best as { line: number; score: number } | null;

    return found ? { line: found.line, exact: false } : null;
}
