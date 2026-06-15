import type { PackInputFile, PackResult } from "./types";

/**
 * Greedily select files within a token budget. PURE — token counts are inputs;
 * this core NEVER calls an encoder. Files are visited in descending rank; a
 * file is included only if it fits the remaining budget (a too-large high-rank
 * file is skipped so smaller lower-rank files can still fit). Input array is
 * not mutated.
 */
export function packByBudget<T extends PackInputFile>({
    files,
    budget,
}: {
    files: T[];
    budget: number;
}): PackResult<T> {
    const sorted = [...files].sort((a, b) => b.rank - a.rank);
    const included: T[] = [];
    const elided: T[] = [];
    let used = 0;

    for (const file of sorted) {
        if (used + file.tokens <= budget) {
            included.push(file);
            used += file.tokens;
        } else {
            elided.push(file);
        }
    }

    return { included, elided, usedTokens: used, budget };
}
