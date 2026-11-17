/**
 * The clock of a recorder sound piece against the source's recording. Both hear the same call, so the energy envelope
 * of the piece matches the envelope of the source's call channel at one lag; that lag is the piece's true second 0
 * on the transcript clock. Pure: the caller decodes the samples.
 */

/** How far from its stamp a piece is searched, each way. */
export const ALIGN_SEARCH_SEC = 3;
/** The envelope step: one energy value per 10 ms. */
const STEP_SEC = 0.01;
/** The peak's correlation must reach this (the envelopes are normalised, so 1 is a perfect match)… */
const CLEAR_SCORE = 0.5;
/** …and stand this far above the best lag outside its own neighbourhood. */
const CLEAR_MARGIN = 0.15;
/** Lags this close to the peak are its own shoulder, not a rival. */
const SHOULDER_STEPS = 10;
/** The piece must overlap the reference by at least this share of its length. */
const MIN_OVERLAP = 0.5;
/** A flat envelope (silence, a steady hum) has no shape to match. */
const MIN_SPREAD_DB = 3;

/** The log energy per step, normalised to mean 0 and spread 1; undefined when it is too flat to match. */
function envelope(samples: Float32Array, rate: number): Float32Array | undefined {
    const size = Math.max(1, Math.round(rate * STEP_SEC));
    const steps = Math.floor(samples.length / size);

    if (steps < 2) {
        return undefined;
    }

    const out = new Float32Array(steps);

    for (let step = 0; step < steps; step++) {
        let sum = 0;

        for (let index = step * size; index < (step + 1) * size; index++) {
            const value = samples[index] ?? 0;
            sum += value * value;
        }

        out[step] = 10 * Math.log10(sum / size + 1e-10);
    }

    let mean = 0;

    for (const value of out) {
        mean += value;
    }

    mean /= steps;
    let variance = 0;

    for (const value of out) {
        variance += (value - mean) ** 2;
    }

    const spread = Math.sqrt(variance / steps);

    if (spread < MIN_SPREAD_DB / 2) {
        return undefined;
    }

    for (let step = 0; step < steps; step++) {
        out[step] = ((out[step] ?? 0) - mean) / spread;
    }

    return out;
}

/** The transcript second the reference window starts at, for a piece stamped at `stampSec`. */
export function alignReferenceFromSec(stampSec: number): number {
    return Math.max(0, stampSec - ALIGN_SEARCH_SEC);
}

/**
 * The offset of a recorder piece against the source's call channel, by energy envelope, within plus or minus 3 s.
 * `reference` holds the source channel from `alignReferenceFromSec(stampSec)` on, at the same `rate` as `piece`.
 * `clear` is false when no lag stands out (silence, a flat hum, two lags alike); `zeroSec` is then the stamp.
 */
export function alignPiece(options: { piece: Float32Array; reference: Float32Array; rate: number; stampSec: number }): {
    zeroSec: number;
    clear: boolean;
} {
    const { rate, stampSec } = options;
    const unclear = { zeroSec: stampSec, clear: false };
    const piece = envelope(options.piece, rate);
    const reference = envelope(options.reference, rate);

    if (!piece || !reference) {
        return unclear;
    }

    const stampStep = Math.round((stampSec - alignReferenceFromSec(stampSec)) / STEP_SEC);
    const maxLag = Math.round(ALIGN_SEARCH_SEC / STEP_SEC);
    const minOverlap = Math.ceil(piece.length * MIN_OVERLAP);
    const scores = new Map<number, number>();

    for (let lag = -maxLag; lag <= maxLag; lag++) {
        const start = stampStep + lag;
        const from = Math.max(0, -start);
        const to = Math.min(piece.length, reference.length - start);
        const overlap = to - from;

        if (overlap < minOverlap) {
            continue;
        }

        let sum = 0;

        for (let index = from; index < to; index++) {
            sum += (piece[index] ?? 0) * (reference[start + index] ?? 0);
        }

        scores.set(lag, sum / overlap);
    }

    let bestLag: number | undefined;
    let best = Number.NEGATIVE_INFINITY;

    for (const [lag, score] of scores) {
        if (score > best) {
            best = score;
            bestLag = lag;
        }
    }

    if (bestLag === undefined || best < CLEAR_SCORE) {
        return unclear;
    }

    let rival = Number.NEGATIVE_INFINITY;

    for (const [lag, score] of scores) {
        if (Math.abs(lag - bestLag) > SHOULDER_STEPS && score > rival) {
            rival = score;
        }
    }

    if (best - rival < CLEAR_MARGIN) {
        return unclear;
    }

    return { zeroSec: stampSec + bestLag * STEP_SEC, clear: true };
}
