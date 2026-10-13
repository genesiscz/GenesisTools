/**
 * Maps a character offset in one build of a minified file onto another build of the same file.
 *
 * Two builds of one chunk usually differ in mangled identifier names (an injected banner or a
 * different minifier input renames everything) while the code structure stays the same. So both
 * texts are compared with every identifier run collapsed to one marker character, and the offset
 * is carried over through a window of that normalized text that occurs exactly once in the target.
 */

const MARK = "\u0001";

export interface NormalizedCode {
    text: string;
    /** Raw offset where each normalized character starts. */
    rawOffsetOf: Int32Array;
    /** Normalized index of the character (or identifier run) covering each raw offset. */
    normOffsetOf: Int32Array;
}

function isIdentStart(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95;
}

function isIdentPart(code: number): boolean {
    return isIdentStart(code) || (code >= 48 && code <= 57);
}

export function normalizeIdentifiers(code: string): NormalizedCode {
    const chars: string[] = [];
    const rawOffsetOf: number[] = [];
    const normOffsetOf = new Int32Array(code.length + 1);
    let i = 0;
    while (i < code.length) {
        const start = i;
        const at = chars.length;
        if (isIdentStart(code.charCodeAt(i))) {
            i++;
            while (i < code.length && isIdentPart(code.charCodeAt(i))) {
                i++;
            }

            chars.push(MARK);
        } else {
            chars.push(code[i]);
            i++;
        }

        rawOffsetOf.push(start);
        normOffsetOf.fill(at, start, i);
    }

    normOffsetOf[code.length] = chars.length;
    return { text: chars.join(""), rawOffsetOf: Int32Array.from(rawOffsetOf), normOffsetOf };
}

export type AlignConfidence = "unique" | "nearest" | "none";

export interface AlignResult {
    /** Offset in the target text, or -1 when nothing matched. */
    offset: number;
    confidence: AlignConfidence;
    /** Normalized characters of the window that matched (bigger is stronger evidence). */
    windowChars: number;
    /** How many places in the target the matching window occurs. */
    candidates: number;
}

const WINDOWS = [512, 256, 128, 64, 32];

function occurrences(haystack: string, needle: string, cap: number): number[] {
    const hits: number[] = [];
    let from = 0;
    while (hits.length < cap) {
        const hit = haystack.indexOf(needle, from);
        if (hit === -1) {
            break;
        }

        hits.push(hit);
        from = hit + 1;
    }

    return hits;
}

/**
 * Carries `offset` (a raw offset in `from`) to the matching raw offset in `to`.
 * Tries centred, then right-anchored, then left-anchored windows, largest first; the first window
 * that occurs exactly once in `to` wins. Without a unique hit it falls back to the hit closest to
 * the proportional position and says so.
 */
export function alignOffset(options: { from: NormalizedCode; to: NormalizedCode; offset: number }): AlignResult {
    const { from, to } = options;
    const q = from.normOffsetOf[Math.max(0, Math.min(options.offset, from.normOffsetOf.length - 1))];
    const insideRun = options.offset - from.rawOffsetOf[q];
    const expected = Math.round((q / Math.max(1, from.text.length)) * to.text.length);
    let fallback: AlignResult = { offset: -1, confidence: "none", windowChars: 0, candidates: 0 };

    for (const size of WINDOWS) {
        const shapes: Array<[number, number]> = [
            [q - (size >> 1), q + (size >> 1)],
            [q, q + size],
            [q - size, q + 1],
        ];
        for (const [rawStart, rawEnd] of shapes) {
            const start = Math.max(0, rawStart);
            const end = Math.min(from.text.length, rawEnd);
            if (end - start < Math.min(size, 16)) {
                continue;
            }

            const hits = occurrences(to.text, from.text.slice(start, end), 64);
            if (hits.length === 0) {
                continue;
            }

            const target = (hit: number): number => {
                const index = Math.min(hit + (q - start), to.rawOffsetOf.length - 1);
                const isRun = from.text[q] === MARK;
                return to.rawOffsetOf[index] + (isRun ? 0 : insideRun);
            };

            if (hits.length === 1) {
                return { offset: target(hits[0]), confidence: "unique", windowChars: end - start, candidates: 1 };
            }

            if (fallback.confidence === "none") {
                const nearest = hits.reduce((best, hit) =>
                    Math.abs(hit - expected) < Math.abs(best - expected) ? hit : best
                );
                fallback = {
                    offset: target(nearest),
                    confidence: "nearest",
                    windowChars: end - start,
                    candidates: hits.length,
                };
            }
        }
    }

    return fallback;
}
