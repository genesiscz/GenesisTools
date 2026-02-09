/**
 * Fuzzy matching utilities for correlating time entries across systems.
 * Used by timely events to match unlinked memories to events.
 */

export interface FuzzyMatchResult {
    targetId: number;
    score: number; // 0–1
    reasons: string[];
}

interface TimeRange {
    from: string | null;
    to: string | null;
}

export interface MatchCandidate extends TimeRange {
    id: number;
    text: string;
}

export interface MatchSource extends TimeRange {
    text: string;
}

/**
 * Parse "HH:MM" or ISO datetime to minutes since midnight.
 */
function parseTimeToMinutes(time: string | null): number | null {
    if (!time) return null;
    const hhmm = time.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) return parseInt(hhmm[1], 10) * 60 + parseInt(hhmm[2], 10);
    const iso = time.match(/T(\d{2}):(\d{2})/);
    if (iso) return parseInt(iso[1], 10) * 60 + parseInt(iso[2], 10);
    return null;
}

/**
 * Time overlap ratio: what fraction of source's duration overlaps with target's range.
 * Returns 0–1 where 1 = source fully contained within target.
 */
export function timeOverlapRatio(source: TimeRange, target: TimeRange): number {
    const s0 = parseTimeToMinutes(source.from);
    const s1 = parseTimeToMinutes(source.to);
    const t0 = parseTimeToMinutes(target.from);
    const t1 = parseTimeToMinutes(target.to);
    if (s0 == null || s1 == null || t0 == null || t1 == null) return 0;
    const dur = s1 - s0;
    if (dur <= 0) return 0;
    const overlap = Math.max(0, Math.min(s1, t1) - Math.max(s0, t0));
    return overlap / dur;
}

/**
 * Tokenize text into lowercase words (>2 chars).
 */
function tokenize(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .replace(/[^a-z0-9áčďéěíňóřšťúůýž]/gi, " ")
            .split(/\s+/)
            .filter((w) => w.length > 2)
    );
}

/**
 * Word-overlap similarity (Jaccard index). Returns 0–1.
 */
export function wordSimilarity(a: string, b: string): number {
    const wa = tokenize(a);
    const wb = tokenize(b);
    if (wa.size === 0 || wb.size === 0) return 0;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter++;
    return inter / new Set([...wa, ...wb]).size;
}

/**
 * Find the best-matching candidate for a source. Returns null if below threshold.
 * Weights: time overlap 70%, content similarity 30%.
 */
export function fuzzyMatchBest(
    source: MatchSource,
    candidates: MatchCandidate[],
    threshold = 0.15
): FuzzyMatchResult | null {
    let best: FuzzyMatchResult | null = null;
    for (const c of candidates) {
        const reasons: string[] = [];
        let score = 0;
        const overlap = timeOverlapRatio(source, c);
        if (overlap > 0) {
            score += overlap * 0.7;
            reasons.push(`time ${Math.round(overlap * 100)}%`);
        }
        const content = wordSimilarity(source.text, c.text);
        if (content > 0) {
            score += content * 0.3;
            reasons.push(`content ${Math.round(content * 100)}%`);
        }
        if (score > (best?.score ?? 0) && score >= threshold) {
            best = { targetId: c.id, score, reasons };
        }
    }
    return best;
}
