/**
 * The maths behind the analytics: similarity measures, concentration measures, session
 * reconstruction, streaks and rolling peaks.
 *
 * Similarity is deliberately computed several ways. Two people can share almost no exact
 * tracks yet sit in the same three genres all day, and a single number would hide which of
 * those is happening — so every comparison reports its components alongside the blend.
 */

export type Vector = Map<string, number>;

export function normalize(v: Vector): Vector {
    let total = 0;
    for (const x of v.values()) {
        total += x;
    }

    if (total <= 0) {
        return new Map();
    }

    const out: Vector = new Map();
    for (const [k, x] of v) {
        out.set(k, x / total);
    }

    return out;
}

export function cosine(a: Vector, b: Vector): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [k, x] of a) {
        na += x * x;
        const y = b.get(k);
        if (y) {
            dot += x * y;
        }
    }

    for (const y of b.values()) {
        nb += y * y;
    }

    if (!na || !nb) {
        return 0;
    }

    return dot / Math.sqrt(na * nb);
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
    if (!a.size && !b.size) {
        return 0;
    }

    let inter = 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const x of small) {
        if (big.has(x)) {
            inter++;
        }
    }

    return inter / (a.size + b.size - inter);
}

export function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
    let n = 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const x of small) {
        if (big.has(x)) {
            n++;
        }
    }

    return n;
}

/** Szymkiewicz-Simpson: how much of the SMALLER collection is contained in the larger. */
export function overlapCoefficient<T>(a: Set<T>, b: Set<T>): number {
    const min = Math.min(a.size, b.size);
    if (!min) {
        return 0;
    }

    return intersectionSize(a, b) / min;
}

/** Jaccard that respects how much each side plays a thing, not just whether they do. */
export function weightedJaccard(a: Vector, b: Vector): number {
    const keys = new Set([...a.keys(), ...b.keys()]);
    let min = 0;
    let max = 0;
    for (const k of keys) {
        const x = a.get(k) ?? 0;
        const y = b.get(k) ?? 0;
        min += Math.min(x, y);
        max += Math.max(x, y);
    }

    if (!max) {
        return 0;
    }

    return min / max;
}

export function pearson(xs: number[], ys: number[]): number {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) {
        return 0;
    }

    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
        sx += xs[i]!;
        sy += ys[i]!;
    }

    const mx = sx / n;
    const my = sy / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
        const a = xs[i]! - mx;
        const b = ys[i]! - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }

    if (!dx || !dy) {
        return 0;
    }

    return num / Math.sqrt(dx * dy);
}

function ranks(values: number[]): number[] {
    const order = values.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const out = new Array<number>(values.length);
    let i = 0;
    while (i < order.length) {
        let j = i;
        while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) {
            j++;
        }

        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) {
            out[order[k]![1]] = avg;
        }

        i = j + 1;
    }

    return out;
}

export function spearman(xs: number[], ys: number[]): number {
    return pearson(ranks(xs), ranks(ys));
}

/** Shannon entropy scaled to 0-1 against a perfectly even spread of the same size. */
export function normalizedEntropy(counts: number[]): number {
    const positive = counts.filter((x) => x > 0);
    if (positive.length < 2) {
        return 0;
    }

    const total = positive.reduce((a, b) => a + b, 0);
    let h = 0;
    for (const x of positive) {
        const p = x / total;
        h -= p * Math.log(p);
    }

    return h / Math.log(positive.length);
}

/** 0 = every item played equally, 1 = one item takes everything. */
export function gini(values: number[]): number {
    const v = values.filter((x) => x > 0).sort((a, b) => a - b);
    if (v.length < 2) {
        return 0;
    }

    const n = v.length;
    let cum = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
        cum += (i + 1) * v[i]!;
        total += v[i]!;
    }

    if (!total) {
        return 0;
    }

    return (2 * cum) / (n * total) - (n + 1) / n;
}

export type Session<T> = { start: number; end: number; items: T[] };

/** Consecutive plays separated by less than `gapMs` of silence are one sitting. */
export function sessionize<T extends { ts: number; ms: number }>(items: T[], gapMs: number): Session<T>[] {
    const sorted = [...items].sort((a, b) => a.ts - b.ts);
    const out: Session<T>[] = [];
    let cur: Session<T> | null = null;
    for (const it of sorted) {
        if (cur && it.ts - cur.end <= gapMs) {
            cur.items.push(it);
            cur.end = Math.max(cur.end, it.ts + it.ms);
            continue;
        }

        cur = { start: it.ts, end: it.ts + it.ms, items: [it] };
        out.push(cur);
    }

    return out;
}

export type Streak = { length: number; start: string; end: string };

export function longestStreak(days: Iterable<string>): {
    longest: Streak | null;
    current: Streak | null;
    total: number;
} {
    const sorted = [...new Set(days)].sort();
    if (!sorted.length) {
        return { longest: null, current: null, total: 0 };
    }

    const step = (d: string) => new Date(`${d}T00:00:00Z`).getTime() + 86400000;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

    let best: Streak | null = null;
    let runStart = sorted[0]!;
    let runLen = 1;
    for (let i = 1; i < sorted.length; i++) {
        if (iso(step(sorted[i - 1]!)) === sorted[i]) {
            runLen++;
        } else {
            if (!best || runLen > best.length) {
                best = { length: runLen, start: runStart, end: sorted[i - 1]! };
            }

            runStart = sorted[i]!;
            runLen = 1;
        }
    }

    if (!best || runLen > best.length) {
        best = { length: runLen, start: runStart, end: sorted[sorted.length - 1]! };
    }

    const current: Streak = { length: runLen, start: runStart, end: sorted[sorted.length - 1]! };

    return { longest: best, current, total: sorted.length };
}

/** The densest `windowMs` window in a series of timestamps: the peak of an obsession. */
export function rollingPeak(timestamps: number[], windowMs: number): { count: number; start: number; end: number } {
    const ts = [...timestamps].sort((a, b) => a - b);
    if (!ts.length) {
        return { count: 0, start: 0, end: 0 };
    }

    let best = { count: 0, start: ts[0]!, end: ts[0]! };
    let left = 0;
    for (let right = 0; right < ts.length; right++) {
        while (ts[right]! - ts[left]! > windowMs) {
            left++;
        }

        const count = right - left + 1;
        if (count > best.count) {
            best = { count, start: ts[left]!, end: ts[right]! };
        }
    }

    return best;
}

export function quantile(sorted: number[], q: number): number {
    if (!sorted.length) {
        return 0;
    }

    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) {
        return sorted[lo]!;
    }

    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function topKeys(v: Vector, n: number): Set<string> {
    return new Set(
        [...v.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([k]) => k)
    );
}

export type CompatComponent = { name: string; score: number; weight: number; detail: string };

/**
 * How the four components of a taste blend are weighted, for `compat` (two people) and for
 * `shift` (one person across two windows) alike. One definition, because two copies of a
 * weighting are two answers to "how similar is this" that drift apart silently.
 */
export const TASTE_WEIGHTS = { genres: 0.4, artists: 0.3, topArtists: 0.15, songs: 0.15 } as const;

/** How many of a person's favourite artists the "shared top N" component compares. */
export const TOP_ARTIST_N = 50;

/**
 * One number people actually want, plus the components that produced it. Genre carries the
 * most weight because it survives two libraries that share no exact recordings; exact track
 * overlap carries the least, since it punishes listening to the same music on different
 * releases.
 */
export function blendScore(components: CompatComponent[]): number {
    let sum = 0;
    let weight = 0;
    for (const comp of components) {
        sum += comp.score * comp.weight;
        weight += comp.weight;
    }

    if (!weight) {
        return 0;
    }

    return sum / weight;
}
