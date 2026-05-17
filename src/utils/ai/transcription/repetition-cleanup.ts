import logger from "@app/logger";
import type { TranscriptionSegment } from "@app/utils/ai/types";

const SINGLE_TOKEN_MIN_RUN = 5;
const PHRASE_MIN_RUN = 3;
const MAX_PHRASE_WORDS = 8;
const SEG_DEDUP_GAP_SEC = 2.0;
const ZLIB_FLAG_RATIO = 2.4;
const ZLIB_WINDOW_WORDS = 120;

function norm(s: string): string {
    // Strip ALL non-alphanumeric (not just trailing punctuation) so repetition
    // detection is robust to leading/internal punctuation — `(Ještě` and
    // `Ještě,` and `Ještě` all normalize equal. Diacritics are decomposed and
    // dropped first so Czech case/accent variants collapse together.
    return s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

function spanEq(a: string[], s: number, e: number, t: number): boolean {
    for (let k = 0; k < e - s; k++) {
        if (a[s + k] !== a[t + k]) {
            return false;
        }
    }

    return true;
}

/** Collapse only CONSECUTIVE repeated token n-grams (stable-ts remove_repetition
 *  port). Adjacent-only ⇒ scattered legit repeats survive untouched. */
function collapseRuns(tokens: string[]): string[] {
    let toks = tokens;

    for (let len = 1; len <= MAX_PHRASE_WORDS; len++) {
        const minRun = len === 1 ? SINGLE_TOKEN_MIN_RUN : PHRASE_MIN_RUN;
        const n = toks.map(norm);
        const kept: boolean[] = toks.map(() => true);
        let i = 0;

        while (i + len <= n.length) {
            let reps = 1;

            while (i + (reps + 1) * len <= n.length && spanEq(n, i, i + len, i + reps * len)) {
                reps++;
            }

            if (reps >= minRun) {
                for (let r = 1; r < reps; r++) {
                    for (let k = 0; k < len; k++) {
                        kept[i + r * len + k] = false;
                    }
                }

                i += reps * len;
            } else {
                i += 1;
            }
        }

        toks = toks.filter((_, idx) => kept[idx]);
    }

    return toks;
}

function flagHighCompression(text: string): void {
    // FLAG only (never deletes). Runs on the PRE-cleanup text so it surfaces
    // loops the run-collapse heuristic did NOT catch — checking post-collapse
    // would always look fine and make the warning useless. zlib header
    // (`library:"zlib"`) matches the 2.4 threshold's Python/Node calibration;
    // Bun's default raw deflate would skew the ratio ~5-10%.
    const words = text.split(/\s+/).filter(Boolean);

    for (let i = 0; i < words.length; i += ZLIB_WINDOW_WORDS) {
        const win = words.slice(i, i + ZLIB_WINDOW_WORDS).join(" ");
        const ratio =
            Buffer.byteLength(win, "utf8") / Math.max(1, Bun.deflateSync(Buffer.from(win), { library: "zlib" }).length);

        if (ratio > ZLIB_FLAG_RATIO) {
            logger.warn(
                `repetition-cleanup: window @word ${i} compression ratio ${ratio.toFixed(2)} > ${ZLIB_FLAG_RATIO} (review)`
            );
        }
    }
}

function cleanText(text: string): string {
    flagHighCompression(text);
    return collapseRuns(text.split(/\s+/).filter(Boolean)).join(" ");
}

export function cleanRepetitions(input: { text: string; segments?: TranscriptionSegment[] }): {
    text: string;
    segments?: TranscriptionSegment[];
} {
    if (!input.segments?.length) {
        return { text: cleanText(input.text) };
    }

    flagHighCompression(input.text); // pre-cleanup flag on the full text

    // 1. intra-segment run-collapse
    const intra = input.segments.map((s) => ({
        ...s,
        text: collapseRuns(s.text.split(/\s+/).filter(Boolean)).join(" "),
    }));

    // 2. cross-segment dedup (drop seg == previous surviving within < gap)
    const segs: TranscriptionSegment[] = [];

    for (const s of intra) {
        const prev = segs[segs.length - 1];

        if (
            prev &&
            norm(prev.text) === norm(s.text) &&
            norm(s.text).length > 0 &&
            s.start - prev.end < SEG_DEDUP_GAP_SEC
        ) {
            prev.end = s.end;
            continue;
        }

        segs.push({ ...s });
    }

    // 3. segment run-length (>=5 consecutive identical normalized text → keep first)
    const out: TranscriptionSegment[] = [];
    let i = 0;

    while (i < segs.length) {
        let reps = 1;

        while (
            i + reps < segs.length &&
            norm(segs[i + reps].text) === norm(segs[i].text) &&
            norm(segs[i].text).length > 0
        ) {
            reps++;
        }

        if (reps >= SINGLE_TOKEN_MIN_RUN) {
            out.push({ ...segs[i], end: segs[i + reps - 1].end });
            i += reps;
        } else {
            out.push(segs[i]);
            i += 1;
        }
    }

    return { text: out.map((s) => s.text).join(" "), segments: out };
}
