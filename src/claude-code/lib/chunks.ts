export interface Chunk {
    hash: string;
    text: string;
    display: string;
    startLine: number;
    endLine: number;
}

export interface ChunkSetDiff {
    onlyA: Chunk[];
    onlyB: Chunk[];
    sameCount: number;
}

export interface ChunkPair {
    a?: Chunk;
    b?: Chunk;
    similarity: number;
}

const BOUNDARY = /^ {2}(?:var|let|const|function|class|async function)\b/;

export function splitChunks(normalized: string, display?: string): Chunk[] {
    const normLines = normalized.split("\n");
    const dispLines = (display ?? normalized).split("\n");
    const chunks: Chunk[] = [];
    let start = 0;

    const push = (end: number): void => {
        if (end <= start) {
            return;
        }

        const text = normLines
            .slice(start, end)
            .map((l) => `${l}\n`)
            .join("");
        chunks.push({
            hash: String(Bun.hash(text)),
            text,
            display: dispLines
                .slice(start, end)
                .map((l) => `${l}\n`)
                .join(""),
            startLine: start + 1,
            endLine: end,
        });
        start = end;
    };

    for (let i = 1; i < normLines.length; i++) {
        const line = normLines[i];

        if (line !== undefined && BOUNDARY.test(line)) {
            push(i);
        }
    }

    push(normLines.length);
    return chunks;
}

export function chunkSetDiff(a: Chunk[], b: Chunk[]): ChunkSetDiff {
    const countB = new Map<string, number>();

    for (const c of b) {
        countB.set(c.hash, (countB.get(c.hash) ?? 0) + 1);
    }

    const onlyA: Chunk[] = [];
    let sameCount = 0;

    for (const c of a) {
        const remaining = countB.get(c.hash) ?? 0;

        if (remaining > 0) {
            countB.set(c.hash, remaining - 1);
            sameCount++;
        } else {
            onlyA.push(c);
        }
    }

    const countA = new Map<string, number>();

    for (const c of a) {
        countA.set(c.hash, (countA.get(c.hash) ?? 0) + 1);
    }

    const onlyB: Chunk[] = [];

    for (const c of b) {
        const remaining = countA.get(c.hash) ?? 0;

        if (remaining > 0) {
            countA.set(c.hash, remaining - 1);
        } else {
            onlyB.push(c);
        }
    }

    return { onlyA, onlyB, sameCount };
}

export function filterByPatterns(chunks: Chunk[], patterns: RegExp[]): Chunk[] {
    return chunks.filter((c) =>
        patterns.every((p) => {
            p.lastIndex = 0;
            const textMatch = p.test(c.text);
            p.lastIndex = 0;
            return textMatch || p.test(c.display);
        })
    );
}

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

function literalSet(text: string): Set<string> {
    return new Set(text.match(STRING_LITERAL) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) {
        return 0;
    }

    let intersection = 0;

    for (const s of a) {
        if (b.has(s)) {
            intersection++;
        }
    }

    return intersection / (a.size + b.size - intersection);
}

/**
 * Greedy best-match pairing of changed chunks by shared string literals (identifier-agnostic,
 * survives minifier churn). Pairs below MIN_SIMILARITY stay unpaired (pure add/remove).
 */
export function pairChunks(onlyA: Chunk[], onlyB: Chunk[]): ChunkPair[] {
    const MIN_SIMILARITY = 0.3;
    const setsA = onlyA.map((c) => literalSet(c.text));
    const setsB = onlyB.map((c) => literalSet(c.text));
    const usedB = new Set<number>();
    const pairs: ChunkPair[] = [];

    for (let i = 0; i < onlyA.length; i++) {
        let bestJ = -1;
        let bestSim = 0;

        for (let j = 0; j < onlyB.length; j++) {
            if (usedB.has(j)) {
                continue;
            }

            const setA = setsA[i];
            const setB = setsB[j];
            const sim = setA !== undefined && setB !== undefined ? jaccard(setA, setB) : 0;

            if (sim > bestSim) {
                bestSim = sim;
                bestJ = j;
            }
        }

        if (bestJ >= 0 && bestSim >= MIN_SIMILARITY) {
            usedB.add(bestJ);
            pairs.push({ a: onlyA[i], b: onlyB[bestJ], similarity: bestSim });
        } else {
            pairs.push({ a: onlyA[i], similarity: 0 });
        }
    }

    for (let j = 0; j < onlyB.length; j++) {
        if (!usedB.has(j)) {
            pairs.push({ b: onlyB[j], similarity: 0 });
        }
    }

    return pairs;
}
