/** Resource bounds for the bounded, exact-word-v1 alignment policy. Inputs are never truncated. */
export const WORD_TIMING_ALIGNMENT_LIMITS = {
    windowSeconds: 20,
    words: 512,
    lines: 256,
    textCodeUnits: 65_536,
} as const;

export interface WordTimingLine {
    id?: string;
    text: string;
    startSec?: number;
    endSec?: number;
}

/** One ASR word, with times relative to the beginning of the analyzed window. */
export interface AsrWordTiming {
    text: string;
    startSec: number;
    endSec: number;
}

export interface AlignedWordTiming {
    /** UTF-16 code units in the original corrected line, excluding surrounding prose punctuation. */
    range: { location: number; length: number };
    /** Absolute source-audio clock; the window offset has already been applied. */
    startSec: number;
    endSec: number;
}

export interface WordTimingAlignment {
    /** Only lines with accepted words. lineIndex identifies the unchanged input entry. */
    lines: Array<{ lineIndex: number; id?: string; words: AlignedWordTiming[] }>;
    coverage: {
        eligibleWords: number;
        matchedWords: number;
        ambiguousWords: number;
        unmatchedWords: number;
        invalidAsrWords: number;
        invalidLinesSkipped: number;
        boundaryLinesSkipped: number;
    };
}

interface CorrectedWord {
    normalized: string;
    lineIndex: number;
    range: AlignedWordTiming["range"];
    startSec: number;
    endSec: number;
}

interface TimedWord {
    normalized: string;
    startSec: number;
    endSec: number;
}

function ignorableBoundary(character: string): boolean {
    // Preserve attached code sigils/operators, including their compatibility forms (e.g. ＋).
    return /^[\p{P}\p{S}]$/u.test(character) && !/^[+#@$%&*=<>|^~_\\/-]$/u.test(character.normalize("NFKC"));
}

function trimWord(text: string): { text: string; offset: number } {
    if (!/[\p{L}\p{N}]/u.test(text)) {
        return { text: "", offset: 0 };
    }
    const characters = Array.from(text);
    let leading = 0;
    let trailing = text.length;
    for (const character of characters) {
        if (!ignorableBoundary(character)) {
            break;
        }
        leading += character.length;
    }
    for (let i = characters.length - 1; i >= 0; i--) {
        const character = characters[i];
        if (!ignorableBoundary(character)) {
            break;
        }
        trailing -= character.length;
    }
    return { text: text.slice(leading, trailing), offset: leading };
}

function normalizeWord(text: string): string {
    return text.normalize("NFKC").toLowerCase();
}

function validBounds(start: number | undefined, end: number | undefined): start is number {
    return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start !== undefined &&
        end !== undefined &&
        start >= 0 &&
        end > start
    );
}

/**
 * Align real ASR word intervals to exact corrected words, without changing text or inventing times.
 * Only whole, chronologically ordered transcript lines inside the window are eligible. Invalid
 * ASR entries are discarded; an out-of-order/overlapping entry cannot move the accepted time frontier
 * backwards. Equality uses NFKC and lowercase, retaining diacritics, digits and internal spelling.
 *
 * A candidate must fit its line before alignment. Accept it only if every maximum-length monotone
 * matching contains that pair. An ambiguous, unmatched, crossing, or >1-second word stays line-only.
 */
export function alignWordTimings(input: {
    lines: readonly WordTimingLine[];
    words: readonly AsrWordTiming[];
    window: { fromSec: number; toSec: number };
}): WordTimingAlignment {
    const { lines, words, window } = input;
    const duration = window.toSec - window.fromSec;
    if (!validBounds(window.fromSec, window.toSec) || duration > WORD_TIMING_ALIGNMENT_LIMITS.windowSeconds) {
        throw new RangeError("Word timing window must be finite, nonnegative, positive and at most 20 seconds");
    }
    if (lines.length > WORD_TIMING_ALIGNMENT_LIMITS.lines || words.length > WORD_TIMING_ALIGNMENT_LIMITS.words) {
        throw new RangeError("Word timing input exceeds line or ASR word limits");
    }
    const textSize = [...lines, ...words].reduce(
        (total, entry) => total + (typeof entry.text === "string" ? entry.text.length : 0),
        0
    );
    if (textSize > WORD_TIMING_ALIGNMENT_LIMITS.textCodeUnits) {
        throw new RangeError("Word timing input exceeds the text size limit");
    }

    const coverage: WordTimingAlignment["coverage"] = {
        eligibleWords: 0,
        matchedWords: 0,
        ambiguousWords: 0,
        unmatchedWords: 0,
        invalidAsrWords: 0,
        invalidLinesSkipped: 0,
        boundaryLinesSkipped: 0,
    };
    const corrected: CorrectedWord[] = [];
    let previousLineEnd = 0;
    for (const [lineIndex, line] of lines.entries()) {
        const { startSec, endSec } = line;
        if (
            typeof line.text !== "string" ||
            !validBounds(startSec, endSec) ||
            endSec === undefined ||
            startSec < previousLineEnd
        ) {
            coverage.invalidLinesSkipped++;
            continue;
        }
        previousLineEnd = endSec;
        if (startSec < window.fromSec || endSec > window.toSec) {
            if (endSec > window.fromSec && startSec < window.toSec) {
                coverage.boundaryLinesSkipped++;
            }
            continue;
        }
        for (const match of line.text.matchAll(/\S+/gu)) {
            const trimmed = trimWord(match[0]);
            const normalized = normalizeWord(trimmed.text);
            if (!normalized || /\s/u.test(normalized)) {
                continue;
            }
            corrected.push({
                normalized,
                lineIndex,
                range: { location: match.index + trimmed.offset, length: trimmed.text.length },
                startSec,
                endSec,
            });
            if (corrected.length > WORD_TIMING_ALIGNMENT_LIMITS.words) {
                throw new RangeError("Word timing input exceeds the corrected word limit");
            }
        }
    }
    coverage.eligibleWords = corrected.length;

    const timed: TimedWord[] = [];
    let previousWordEnd = 0;
    for (const word of words) {
        if (
            typeof word.text !== "string" ||
            !validBounds(word.startSec, word.endSec) ||
            word.endSec > duration ||
            word.endSec - word.startSec > 1 ||
            word.startSec < previousWordEnd
        ) {
            coverage.invalidAsrWords++;
            continue;
        }
        const normalized = normalizeWord(trimWord(word.text.trim()).text);
        if (!normalized || /\s/u.test(normalized)) {
            coverage.invalidAsrWords++;
            continue;
        }
        const startSec = window.fromSec + word.startSec;
        const endSec = window.fromSec + word.endSec;
        if (!validBounds(startSec, endSec) || endSec - startSec > 1 || endSec > window.toSec) {
            coverage.invalidAsrWords++;
            continue;
        }
        previousWordEnd = word.endSec;
        timed.push({ normalized, startSec, endSec });
    }

    const rows = corrected.length;
    const cols = timed.length;
    const stride = cols + 1;
    const candidates = new Uint8Array(rows * cols);
    const prefix = new Uint16Array((rows + 1) * stride);
    const suffix = new Uint16Array(prefix.length);
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            const left = corrected[i];
            const right = timed[j];
            const matches =
                left.normalized === right.normalized && right.startSec >= left.startSec && right.endSec <= left.endSec;
            candidates[i * cols + j] = Number(matches);
            prefix[(i + 1) * stride + j + 1] = Math.max(
                prefix[i * stride + j + 1],
                prefix[(i + 1) * stride + j],
                matches ? prefix[i * stride + j] + 1 : 0
            );
        }
    }
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
            suffix[i * stride + j] = Math.max(
                suffix[(i + 1) * stride + j],
                suffix[i * stride + j + 1],
                candidates[i * cols + j] ? suffix[(i + 1) * stride + j + 1] + 1 : 0
            );
        }
    }

    // Every optimal pair has a fixed rank: its longest prefix plus one. Each candidate below
    // belongs to some optimal matching; a rank with one candidate therefore forces that pair.
    const optimum = prefix[rows * stride + cols];
    const byRank: Array<{ i: number; j: number } | null | undefined> = new Array(optimum);
    const possibleCorrected = new Set<number>();
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            const rank = prefix[i * stride + j];
            if (candidates[i * cols + j] && rank + 1 + suffix[(i + 1) * stride + j + 1] === optimum) {
                possibleCorrected.add(i);
                byRank[rank] = byRank[rank] === undefined ? { i, j } : null;
            }
        }
    }

    const result: WordTimingAlignment["lines"] = [];
    for (const pair of byRank) {
        if (!pair) {
            continue;
        }
        const word = corrected[pair.i];
        const time = timed[pair.j];
        let line = result[result.length - 1];
        if (!line || line.lineIndex !== word.lineIndex) {
            line = { lineIndex: word.lineIndex, words: [] };
            const id = lines[word.lineIndex].id;
            if (id !== undefined) {
                line.id = id;
            }
            result.push(line);
        }
        line.words.push({ range: word.range, startSec: time.startSec, endSec: time.endSec });
        possibleCorrected.delete(pair.i);
        coverage.matchedWords++;
    }
    coverage.ambiguousWords = possibleCorrected.size;
    coverage.unmatchedWords = coverage.eligibleWords - coverage.matchedWords - coverage.ambiguousWords;
    return { lines: result, coverage };
}
