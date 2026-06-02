import type { RankedFile, RankInputFile } from "./types";

const DAY_MS = 86_400_000;

/** Normalize an array of raw values to 0..1 by max (0 when all zero). */
function normalizeByMax(values: number[]): number[] {
    const max = Math.max(0, ...values);

    if (max === 0) {
        return values.map(() => 0);
    }

    return values.map((v) => v / max);
}

/**
 * Rank files by importance. PURE — `now` is injected; the core never reads the
 * system clock. Score = weighted blend of normalized size, fan-in, and recency
 * (exponential decay of age in days). Returns a new array sorted descending by
 * rank (ties broken by path for stable ordering).
 */
export function rankFiles({ files, now }: { files: RankInputFile[]; now: number }): RankedFile[] {
    const sizes = normalizeByMax(files.map((f) => f.size));
    const fanIns = normalizeByMax(files.map((f) => f.fanIn));
    const recency = files.map((f) => {
        const ageDays = Math.max(0, (now - f.mtimeMs) / DAY_MS);
        return 0.5 ** (ageDays / 14);
    });

    const W_SIZE = 0.2;
    const W_FANIN = 0.5;
    const W_RECENCY = 0.3;

    const ranked: RankedFile[] = files.map((f, i) => ({
        ...f,
        rank: W_SIZE * sizes[i] + W_FANIN * fanIns[i] + W_RECENCY * recency[i],
    }));

    return ranked.sort((a, b) => {
        if (b.rank !== a.rank) {
            return b.rank - a.rank;
        }

        return a.path.localeCompare(b.path);
    });
}
