import { gain, RATE, type Stereo, stereo } from "./dsp";
import { filterPass } from "./effects";
import type { Room } from "./types";

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;

/** Freeverb (Jezar, public domain): eight damped combs into four allpasses for each side. */
export function room(input: Stereo, options: Room): Stereo {
    const total = input.left.length;
    const out = stereo(total);
    const feedback = options.size * 0.28 + 0.7;
    const damp = options.damp * 0.4;
    const predelay = Math.round(((options.predelay ?? 0) / 1000) * RATE);
    const ratio = RATE / 44100;

    [out.left, out.right].forEach((channel, side) => {
        const combs = COMBS.map((length) => ({
            line: new Float32Array(Math.round((length + side * SPREAD) * ratio)),
            at: 0,
            store: 0,
        }));
        const allpasses = ALLPASSES.map((length) => ({
            line: new Float32Array(Math.round((length + side * SPREAD) * ratio)),
            at: 0,
        }));

        for (let n = 0; n < total; n++) {
            const from = n - predelay;
            const dry = from >= 0 ? (input.left[from] + input.right[from]) * 0.015 : 0;
            let sample = 0;

            for (const comb of combs) {
                const value = comb.line[comb.at];
                comb.store = value * (1 - damp) + comb.store * damp;
                comb.line[comb.at] = dry + comb.store * feedback;
                comb.at = (comb.at + 1) % comb.line.length;
                sample += value;
            }

            for (const allpass of allpasses) {
                const value = allpass.line[allpass.at];
                allpass.line[allpass.at] = sample + value * 0.5;
                allpass.at = (allpass.at + 1) % allpass.line.length;
                sample = value - sample;
            }

            channel[n] = sample * 3 * gain(options.level ?? 0);
        }
    });

    if (options.highpass) {
        filterPass(out, "highpass", options.highpass);
    }

    if (options.lowpass) {
        filterPass(out, "lowpass", options.lowpass);
    }

    return out;
}

/** A knee above `threshold` that bends peaks toward 1 instead of cutting them. */
export function softClip(buffer: Stereo, threshold = 0.7): void {
    for (const channel of [buffer.left, buffer.right]) {
        for (let n = 0; n < channel.length; n++) {
            const x = channel[n];
            const size = Math.abs(x);

            if (size > threshold) {
                channel[n] =
                    Math.sign(x) * (threshold + (1 - threshold) * Math.tanh((size - threshold) / (1 - threshold)));
            }
        }
    }
}

/**
 * A look-ahead peak limiter. The gain reaches its lowest value when the peak arrives, because the audio waits
 * `lookahead` milliseconds while the gain falls. No sample leaves above `ceiling`.
 */
export function limit(buffer: Stereo, ceiling: number, lookahead = 4, release = 90): void {
    const total = buffer.left.length;
    const window = Math.max(1, Math.round((lookahead / 1000) * RATE));
    const need = new Float32Array(total);

    for (let n = 0; n < total; n++) {
        const peak = Math.max(Math.abs(buffer.left[n]), Math.abs(buffer.right[n]));
        need[n] = peak > ceiling ? ceiling / peak : 1;
    }

    // The lowest gain needed in the next `window` samples (a monotonic queue, read from the end).
    const queue = new Int32Array(total);
    const held = new Float32Array(total);
    let head = 0;
    let tail = 0;

    for (let n = total - 1; n >= 0; n--) {
        while (tail > head && need[queue[tail - 1]] >= need[n]) {
            tail--;
        }

        queue[tail++] = n;

        while (queue[head] > n + window - 1) {
            head++;
        }

        held[n] = need[queue[head]];
    }

    // Fall at once, rise slowly. Then average over the window, so the fall is a ramp and not a step.
    const rise = 1 - Math.exp(-1 / ((release / 1000) * RATE));
    const sums = new Float64Array(total + 1);
    let level = 1;

    for (let n = 0; n < total; n++) {
        level = Math.min(held[n], level + (1 - level) * rise);
        sums[n + 1] = sums[n] + level;
    }

    for (let n = 0; n < total; n++) {
        const start = Math.max(0, n - window + 1);
        const smooth = (sums[n + 1] - sums[start]) / (n + 1 - start);
        buffer.left[n] *= smooth;
        buffer.right[n] *= smooth;
    }
}
