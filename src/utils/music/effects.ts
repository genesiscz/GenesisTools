import { type Curve, gain, RATE, type Stereo, Svf } from "./dsp";
import type { Effects, EqBand } from "./types";

const CONTROL = 32;

function each(buffer: Stereo, run: (channel: Float32Array) => void): void {
    run(buffer.left);
    run(buffer.right);
}

/** 24 dB per octave low or high pass. A curve moves the cutoff over score time. */
export function filterPass(buffer: Stereo, type: "lowpass" | "highpass", cutoff: number | Curve): void {
    each(buffer, (channel) => {
        const stages = [new Svf(), new Svf()];

        for (let n = 0; n < channel.length; n++) {
            if (n % CONTROL === 0 && (n === 0 || typeof cutoff !== "number")) {
                const f = typeof cutoff === "number" ? cutoff : cutoff.at(n / RATE);
                stages[0].set(f, 0.541);
                stages[1].set(f, 1.307);
            }

            let sample = channel[n];

            for (const stage of stages) {
                stage.tick(sample);
                sample = type === "lowpass" ? stage.low : stage.high;
            }

            channel[n] = sample;
        }
    });
}

function biquad(band: EqBand): [number, number, number, number, number] {
    const a = 10 ** (band.gain / 40);
    const w = (2 * Math.PI * band.frequency) / RATE;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * (band.q ?? Math.SQRT1_2));
    const root = 2 * Math.sqrt(a) * alpha;
    let b: [number, number, number];
    let c: [number, number, number];

    if (band.type === "peak") {
        b = [1 + alpha * a, -2 * cos, 1 - alpha * a];
        c = [1 + alpha / a, -2 * cos, 1 - alpha / a];
    } else if (band.type === "lowshelf") {
        b = [a * (a + 1 - (a - 1) * cos + root), 2 * a * (a - 1 - (a + 1) * cos), a * (a + 1 - (a - 1) * cos - root)];
        c = [a + 1 + (a - 1) * cos + root, -2 * (a - 1 + (a + 1) * cos), a + 1 + (a - 1) * cos - root];
    } else {
        b = [a * (a + 1 + (a - 1) * cos + root), -2 * a * (a - 1 + (a + 1) * cos), a * (a + 1 + (a - 1) * cos - root)];
        c = [a + 1 - (a - 1) * cos + root, 2 * (a - 1 - (a + 1) * cos), a + 1 - (a - 1) * cos - root];
    }

    return [b[0] / c[0], b[1] / c[0], b[2] / c[0], c[1] / c[0], c[2] / c[0]];
}

export function equalize(buffer: Stereo, band: EqBand): void {
    const [b0, b1, b2, a1, a2] = biquad(band);
    each(buffer, (channel) => {
        let x1 = 0;
        let x2 = 0;
        let y1 = 0;
        let y2 = 0;

        for (let n = 0; n < channel.length; n++) {
            const x = channel[n];
            const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            channel[n] = y;
        }
    });
}

function rms(buffer: Stereo): number {
    let sum = 0;

    for (let n = 0; n < buffer.left.length; n++) {
        sum += buffer.left[n] ** 2 + buffer.right[n] ** 2;
    }

    return Math.sqrt(sum / (2 * buffer.left.length));
}

export function saturate(buffer: Stereo, options: NonNullable<Effects["drive"]>): void {
    const before = rms(buffer);
    const drive = gain(options.amount);
    const mix = options.mix ?? 1;
    const shape = options.shape ?? "tanh";
    each(buffer, (channel) => {
        for (let n = 0; n < channel.length; n++) {
            const x = channel[n] * drive;
            const wet = shape === "tanh" ? Math.tanh(x) : shape === "hard" ? Math.max(-1, Math.min(1, x)) : Math.sin(x);
            channel[n] = channel[n] * (1 - mix) + wet * mix;
        }
    });
    const after = rms(buffer);

    if (after > 0 && before > 0) {
        scale(buffer, before / after);
    }
}

export function scale(buffer: Stereo, factor: number): void {
    each(buffer, (channel) => {
        for (let n = 0; n < channel.length; n++) {
            channel[n] *= factor;
        }
    });
}

export function crush(buffer: Stereo, options: NonNullable<Effects["crush"]>): void {
    const steps = options.bits ? 2 ** (options.bits - 1) : 0;
    const hold = Math.max(1, Math.round(options.hold ?? 1));
    each(buffer, (channel) => {
        let held = 0;

        for (let n = 0; n < channel.length; n++) {
            if (n % hold === 0) {
                held = steps ? Math.round(channel[n] * steps) / steps : channel[n];
            }

            channel[n] = held;
        }
    });
}

export function compress(buffer: Stereo, options: NonNullable<Effects["compressor"]>): void {
    const attack = Math.exp(-1 / ((options.attack / 1000) * RATE));
    const release = Math.exp(-1 / ((options.release / 1000) * RATE));
    const makeup = gain(options.makeup ?? 0);
    let envelope = 0;

    for (let n = 0; n < buffer.left.length; n++) {
        const peak = Math.max(Math.abs(buffer.left[n]), Math.abs(buffer.right[n]));
        envelope = peak > envelope ? peak + (envelope - peak) * attack : peak + (envelope - peak) * release;
        const over = 20 * Math.log10(Math.max(envelope, 1e-9)) - options.threshold;
        const factor = over > 0 ? gain(-over * (1 - 1 / options.ratio)) * makeup : makeup;
        buffer.left[n] *= factor;
        buffer.right[n] *= factor;
    }
}

export function delay(buffer: Stereo, options: NonNullable<Effects["delay"]>): void {
    const length = Math.max(1, Math.round(options.time * RATE));
    const lines = [new Float32Array(length), new Float32Array(length)];
    const damp = options.lowpass ? 1 - Math.exp((-2 * Math.PI * options.lowpass) / RATE) : 1;
    const state = [0, 0];

    for (let n = 0; n < buffer.left.length; n++) {
        const at = n % length;
        const outs = [lines[0][at], lines[1][at]];
        const ins = options.pingPong
            ? [(buffer.left[n] + buffer.right[n]) * 0.5 + outs[1] * options.feedback, outs[0] * options.feedback]
            : [buffer.left[n] + outs[0] * options.feedback, buffer.right[n] + outs[1] * options.feedback];

        for (let c = 0; c < 2; c++) {
            state[c] += (ins[c] - state[c]) * damp;
            lines[c][at] = state[c];
        }

        buffer.left[n] += outs[0] * options.mix;
        buffer.right[n] += outs[1] * options.mix;
    }
}

export function widen(buffer: Stereo, width: number, monoBelow?: number): void {
    const filter = monoBelow ? [new Svf(), new Svf()] : undefined;
    filter?.[0].set(monoBelow ?? 0, 0.541);
    filter?.[1].set(monoBelow ?? 0, 1.307);

    for (let n = 0; n < buffer.left.length; n++) {
        const mid = (buffer.left[n] + buffer.right[n]) * 0.5;
        let side = (buffer.left[n] - buffer.right[n]) * 0.5 * width;

        if (filter) {
            filter[0].tick(side);
            filter[1].tick(filter[0].high);
            side = filter[1].high;
        }

        buffer.left[n] = mid + side;
        buffer.right[n] = mid - side;
    }
}

/** The dip is complete at each trigger, because an offline render can start the attack before the hit. */
export function duck(buffer: Stereo, options: NonNullable<Effects["duck"]>, triggers: number[]): void {
    const total = buffer.left.length;
    const curve = new Float32Array(total).fill(1);
    const attack = Math.max(1, Math.round(((options.attack ?? 3) / 1000) * RATE));
    const hold = Math.round(((options.hold ?? 20) / 1000) * RATE);
    const release = Math.max(1, Math.round((options.release / 1000) * RATE));

    for (const seconds of triggers) {
        const hit = Math.round(seconds * RATE);

        for (let k = -attack; k < hold + release; k++) {
            const n = hit + k;

            if (n < 0 || n >= total) {
                continue;
            }

            const amount =
                k < 0 ? 1 + k / attack : k < hold ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (k - hold)) / release);
            curve[n] = Math.min(curve[n], 1 - options.depth * amount);
        }
    }

    for (let n = 0; n < total; n++) {
        buffer.left[n] *= curve[n];
        buffer.right[n] *= curve[n];
    }
}

/** The chain in its fixed order. The room send is the mixer's job. */
export function applyEffects(options: {
    buffer: Stereo;
    effects: Effects;
    lanes: Map<string, Curve>;
    triggers: (part: string) => number[];
}): void {
    const { buffer, effects, lanes } = options;
    const highpass = lanes.get("highpass") ?? effects.highpass;
    const lowpass = lanes.get("lowpass") ?? effects.lowpass;

    if (highpass !== undefined) {
        filterPass(buffer, "highpass", highpass);
    }

    if (lowpass !== undefined) {
        filterPass(buffer, "lowpass", lowpass);
    }

    for (const band of effects.eq ?? []) {
        equalize(buffer, band);
    }

    if (effects.drive) {
        saturate(buffer, effects.drive);
    }

    if (effects.crush) {
        crush(buffer, effects.crush);
    }

    if (effects.compressor) {
        compress(buffer, effects.compressor);
    }

    if (effects.delay) {
        delay(buffer, effects.delay);
    }

    if (effects.width !== undefined || effects.monoBelow !== undefined) {
        widen(buffer, effects.width ?? 1, effects.monoBelow);
    }

    if (effects.duck) {
        duck(buffer, effects.duck, effects.duck.by.flatMap(options.triggers));
    }

    if (effects.gain) {
        scale(buffer, gain(effects.gain));
    }
}
