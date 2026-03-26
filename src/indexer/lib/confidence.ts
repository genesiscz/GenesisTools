export type ScoreMethod = "cosine" | "rrf" | "bm25";

const RRF_THEORETICAL_MAX = 2 / 61;

export function normalizeConfidence(score: number, method: ScoreMethod, maxScore?: number): number {
    let normalized: number;

    switch (method) {
        case "cosine":
            normalized = score * 100;
            break;

        case "rrf":
            normalized = (score / RRF_THEORETICAL_MAX) * 100;
            break;

        case "bm25":
            if (maxScore !== undefined && maxScore > 0) {
                normalized = (score / maxScore) * 100;
            } else {
                normalized = Math.min(score * 5, 100);
            }
            break;
    }

    return Math.round(Math.max(0, Math.min(100, normalized)));
}
