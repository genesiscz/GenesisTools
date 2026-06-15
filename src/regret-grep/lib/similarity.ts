import { termFrequencies, tokenize } from "./tokenize";
import type { RegretEntry, RegretIndex } from "./types";

/**
 * A scored match between the query diff and one indexed bug-fix commit.
 */
export interface ScoredMatch {
    entry: RegretEntry;
    /** Cosine similarity in [0, 1]. */
    score: number;
    /** Tokens shared by the query and the entry, ranked by combined weight. */
    overlap: string[];
}

/**
 * Compute inverse-document-frequency weights across all indexed entries.
 *
 * idf(t) = ln( (N + 1) / (df(t) + 1) ) + 1   (smoothed, always > 0)
 */
export function computeIdf(entries: RegretEntry[]): Map<string, number> {
    const docCount = entries.length;
    const docFrequency = new Map<string, number>();

    for (const entry of entries) {
        const seen = new Set(entry.tokens);
        for (const token of seen) {
            docFrequency.set(token, (docFrequency.get(token) ?? 0) + 1);
        }
    }

    const idf = new Map<string, number>();
    for (const [token, df] of docFrequency) {
        idf.set(token, Math.log((docCount + 1) / (df + 1)) + 1);
    }

    return idf;
}

/**
 * Build a TF-IDF vector (token -> weight) from a term-frequency map.
 *
 * Unknown tokens (absent from idf) still get a weight using the maximum
 * possible idf for the corpus, so a brand-new salient token in the query is
 * not silently zeroed out.
 */
function tfIdfVector(tf: Map<string, number>, idf: Map<string, number>, fallbackIdf: number): Map<string, number> {
    const vector = new Map<string, number>();
    for (const [token, freq] of tf) {
        const weight = idf.get(token) ?? fallbackIdf;
        vector.set(token, freq * weight);
    }

    return vector;
}

function l2norm(vector: Map<string, number>): number {
    let sum = 0;
    for (const value of vector.values()) {
        sum += value * value;
    }

    return Math.sqrt(sum);
}

/**
 * Cosine similarity between two sparse TF-IDF vectors. Returns 0 when either
 * vector is empty.
 */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
    const normA = l2norm(a);
    const normB = l2norm(b);
    if (normA === 0 || normB === 0) {
        return 0;
    }

    // Iterate the smaller vector for the dot product.
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [token, value] of small) {
        const other = large.get(token);
        if (other !== undefined) {
            dot += value * other;
        }
    }

    return dot / (normA * normB);
}

/**
 * Score a query diff against every entry in the index using lexical TF-IDF
 * cosine similarity. Results are sorted by descending score.
 *
 * Pure and deterministic: same index + same query text → same ranking.
 */
export function scoreQuery(queryText: string, index: RegretIndex, topN = 5): ScoredMatch[] {
    if (index.entries.length === 0) {
        return [];
    }

    const idf = computeIdf(index.entries);
    let fallbackIdf = 1;
    for (const value of idf.values()) {
        if (value > fallbackIdf) {
            fallbackIdf = value;
        }
    }

    const queryTokens = tokenize(queryText);
    const queryTf = termFrequencies(queryTokens);
    const queryVec = tfIdfVector(queryTf, idf, fallbackIdf);

    const matches: ScoredMatch[] = [];
    for (const entry of index.entries) {
        const entryTf = termFrequencies(entry.tokens);
        const entryVec = tfIdfVector(entryTf, idf, fallbackIdf);
        const score = cosine(queryVec, entryVec);
        if (score <= 0) {
            continue;
        }

        const overlap = rankedOverlap(queryVec, entryVec);
        matches.push({ entry, score, overlap });
    }

    matches.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }

        // Deterministic tie-break: newer commit first, then hash.
        if (b.entry.timestamp !== a.entry.timestamp) {
            return b.entry.timestamp - a.entry.timestamp;
        }

        return a.entry.hash.localeCompare(b.entry.hash);
    });

    return matches.slice(0, topN);
}

/**
 * Tokens present in both vectors, ranked by the product of their two weights
 * (the terms contributing most to the similarity), capped at 8.
 */
function rankedOverlap(queryVec: Map<string, number>, entryVec: Map<string, number>): string[] {
    const shared: Array<{ token: string; weight: number }> = [];
    for (const [token, qWeight] of queryVec) {
        const eWeight = entryVec.get(token);
        if (eWeight !== undefined) {
            shared.push({ token, weight: qWeight * eWeight });
        }
    }

    shared.sort((a, b) => {
        if (b.weight !== a.weight) {
            return b.weight - a.weight;
        }

        return a.token.localeCompare(b.token);
    });

    return shared.slice(0, 8).map((s) => s.token);
}
