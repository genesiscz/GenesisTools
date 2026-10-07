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
 * - `unavailable`: the reviewer's version could not be read (a sha gone after a force push).
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
}

/** A changed region in the reviewer's file: removed lines `[start, end]`, or an insertion before `start` (`end = start - 1`). */
interface OldRegion {
    start: number;
    end: number;
}

function changedRegions(
    reviewer: string[],
    tip: string[]
): { regions: OldRegion[]; tipLineOf: (line: number) => number | null } {
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

    return { regions, tipLineOf: (line) => kept.get(line) ?? null };
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
            : { label: "deleted", tipLine: null, text: "deleted at the tip" };
    }

    const { regions, tipLineOf } = changedRegions(input.reviewer, input.tip);
    const tipLine = tipLineOf(input.anchorLine);

    if (regions.length === 0) {
        return { label: "unchanged", tipLine, text: "unchanged" };
    }

    if (tipLine === null || regions.some((region) => touches(region, input.anchorLine, input.anchorLine))) {
        return { label: "changed at the anchor", tipLine, text: "changed at the anchor" };
    }

    const from = input.anchorLine - input.window;
    const to = input.anchorLine + input.window;

    if (regions.some((region) => touches(region, from, to))) {
        return { label: "changed nearby", tipLine, text: "changed nearby" };
    }

    const moved = tipLine === input.anchorLine ? "" : ` (L${input.anchorLine} → L${tipLine})`;

    return { label: "changed elsewhere", tipLine, text: `changed elsewhere${moved}` };
}
