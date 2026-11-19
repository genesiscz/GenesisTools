import { gain, RATE, type Stereo, Svf, stereo } from "./dsp";
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

/** The band under this frequency is the low end that `guardLows` watches. */
const LOW_END_HZ = 120;
/** The deepest cut of the low end, in dB. */
const LOW_GUARD_FLOOR_DB = 9;

/** A fourth-order Linkwitz-Riley split at `LOW_END_HZ`: after a tick, `low` and `high` hold the two bands. */
class BandSplit {
    private readonly lowA = new Svf();
    private readonly lowB = new Svf();
    private readonly highA = new Svf();
    private readonly highB = new Svf();
    low = 0;
    high = 0;

    constructor() {
        this.lowA.set(LOW_END_HZ, 0.541);
        this.lowB.set(LOW_END_HZ, 1.307);
        this.highA.set(LOW_END_HZ, 0.541);
        this.highB.set(LOW_END_HZ, 1.307);
    }

    tick(sample: number): void {
        this.lowA.tick(sample);
        this.lowB.tick(this.lowA.low);
        this.highA.tick(sample);
        this.highB.tick(this.highA.high);
        this.low = this.lowB.low;
        this.high = this.highB.high;
    }
}

/**
 * Keep the low end at most `maxOverDb` above the rest of the mix. A loudness meter hardly counts a sub note, so a
 * mix whose sub stands far over everything else is pushed into the limiter until the sub is a square wave, and
 * that is hard on a speaker. Where the low end is too far up, a slow shelf brings it down, at most
 * `LOW_GUARD_FLOOR_DB`. Returns the deepest cut in dB.
 */
export function guardLows(buffer: Stereo, maxOverDb: number): number {
    // Each side is filtered on its own, so bass in opposite phase on the two sides is still metered.
    const leftBand = new BandSplit();
    const rightBand = new BandSplit();
    const meter = 1 - Math.exp(-1 / (0.3 * RATE));
    const glide = 1 - Math.exp(-1 / (0.15 * RATE));
    const pole = 1 - Math.exp((-2 * Math.PI * LOW_END_HZ) / RATE);
    const ratio = gain(maxOverDb) ** 2;
    const floor = gain(-LOW_GUARD_FLOOR_DB);
    let lowPower = 0;
    let restPower = 0;
    let level = 1;
    let deepest = 1;
    let left = 0;
    let right = 0;

    for (let n = 0; n < buffer.left.length; n++) {
        leftBand.tick(buffer.left[n]);
        rightBand.tick(buffer.right[n]);
        const low = (leftBand.low ** 2 + rightBand.low ** 2) / 2;
        const rest = (leftBand.high ** 2 + rightBand.high ** 2) / 2;
        lowPower += meter * (low - lowPower);
        restPower += meter * (rest - restPower);
        const tooMuch = lowPower > 1e-7 && lowPower > ratio * restPower;
        const wanted = tooMuch ? Math.max(floor, Math.sqrt((ratio * restPower) / lowPower)) : 1;
        level += glide * (wanted - level);
        deepest = Math.min(deepest, level);
        // The cut is a first-order shelf: the input minus a share of its own low end, which has no bump.
        left += pole * (buffer.left[n] - left);
        right += pole * (buffer.right[n] - right);
        buffer.left[n] -= (1 - level) * left;
        buffer.right[n] -= (1 - level) * right;
    }

    return -20 * Math.log10(deepest);
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
 * `lookahead` milliseconds while the gain falls. No sample leaves above `ceiling`. Its working memory is two
 * lookahead windows, whatever the length of the track.
 */
export function limit(buffer: Stereo, ceiling: number, lookahead = 4, release = 90): void {
    const total = buffer.left.length;
    const window = Math.max(1, Math.round((lookahead / 1000) * RATE));
    const rise = 1 - Math.exp(-1 / ((release / 1000) * RATE));
    // The lowest gain needed in the next `window` samples: a monotonic queue of (sample, gain) in a ring.
    const queueAt = new Int32Array(window);
    const queueNeed = new Float32Array(window);
    let head = 0;
    let size = 0;
    let ahead = 0;
    // The last `window` gains and their sum, so the fall is a ramp and not a step.
    const levels = new Float64Array(window);
    let sum = 0;
    let level = 1;

    for (let n = 0; n < total; n++) {
        while (size > 0 && queueAt[head] < n) {
            head = (head + 1) % window;
            size--;
        }

        const last = Math.min(total - 1, n + window - 1);

        while (ahead <= last) {
            const peak = Math.max(Math.abs(buffer.left[ahead]), Math.abs(buffer.right[ahead]));
            const need = Math.fround(peak > ceiling ? ceiling / peak : 1);

            while (size > 0 && queueNeed[(head + size - 1) % window] >= need) {
                size--;
            }

            const slot = (head + size) % window;
            queueAt[slot] = ahead;
            queueNeed[slot] = need;
            size++;
            ahead++;
        }

        // Fall at once, rise slowly. Then average over the window.
        level = Math.min(queueNeed[head], level + (1 - level) * rise);
        const slot = n % window;
        sum += level - (n >= window ? levels[slot] : 0);
        levels[slot] = level;
        const smooth = sum / Math.min(n + 1, window);
        buffer.left[n] *= smooth;
        buffer.right[n] *= smooth;
    }
}
