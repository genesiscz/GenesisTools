import type { Envelope } from "./types";

export const RATE = 48000;

export interface Stereo {
    left: Float32Array;
    right: Float32Array;
}

export function stereo(samples: number): Stereo {
    return { left: new Float32Array(samples), right: new Float32Array(samples) };
}

/** A small seeded generator (mulberry32), so a render repeats bit for bit. */
export function random(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function hash(text: string): number {
    let h = 2166136261;

    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }

    return h >>> 0;
}

export const gain = (decibels: number) => 10 ** (decibels / 20);
export const hertz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Zero-delay state-variable filter (Zavalishin). It stays stable while the cutoff moves fast. */
export class Svf {
    private a1 = 0;
    private a2 = 0;
    private a3 = 0;
    private k = 1;
    private s1 = 0;
    private s2 = 0;
    low = 0;
    band = 0;
    high = 0;

    set(cutoff: number, q: number): void {
        const f = Math.min(Math.max(cutoff, 16), RATE * 0.45);
        const g = Math.tan((Math.PI * f) / RATE);
        this.k = 1 / q;
        this.a1 = 1 / (1 + g * (g + this.k));
        this.a2 = g * this.a1;
        this.a3 = g * this.a2;
    }

    /** After a tick: `low`, `high`, and `band` with unity gain at the cutoff. */
    tick(input: number): void {
        const v3 = input - this.s2;
        const v1 = this.a1 * this.s1 + this.a2 * v3;
        const v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
        this.s1 = 2 * v1 - this.s1;
        this.s2 = 2 * v2 - this.s2;
        this.low = v2;
        this.band = this.k * v1;
        this.high = input - this.k * v1 - v2;
    }
}

/** Linear attack, exponential decay and release. `decay` and `release` are the times to fall 40 dB. */
export class Adsr {
    level = 0;
    done = true;
    private stage: "idle" | "attack" | "decay" | "release" = "idle";
    private readonly attackStep: number;
    private readonly decayCoef: number;
    private readonly releaseCoef: number;
    private readonly releaseTotal: number;
    private releaseLeft = 0;
    private releaseLevel = 0;

    constructor(private readonly spec: Envelope) {
        this.attackStep = 1 / Math.max(1, spec.attack * RATE);
        this.decayCoef = Math.exp(-4.6 / Math.max(1, spec.decay * RATE));
        this.releaseTotal = Math.max(1, Math.round(spec.release * RATE));
        this.releaseCoef = Math.exp(-4.6 / this.releaseTotal);
    }

    gate(on: boolean): void {
        if (on) {
            this.stage = "attack";
            this.done = false;
            return;
        }

        if (this.stage === "idle" || this.stage === "release") {
            return;
        }

        this.stage = "release";
        this.releaseLevel = this.level;
        this.releaseLeft = this.releaseTotal;
    }

    tick(): number {
        if (this.stage === "attack") {
            this.level += this.attackStep;

            if (this.level >= 1) {
                this.level = 1;
                this.stage = "decay";
            }
        } else if (this.stage === "decay") {
            this.level = this.spec.sustain + (this.level - this.spec.sustain) * this.decayCoef;
        } else if (this.stage === "release") {
            this.releaseLevel *= this.releaseCoef;
            this.releaseLeft--;
            this.level = this.releaseLevel * (this.releaseLeft / this.releaseTotal);

            if (this.releaseLeft <= 0) {
                this.level = 0;
                this.stage = "idle";
                this.done = true;
            }
        }

        return this.level;
    }
}

/** Breakpoints over time, read with a cursor because renders ask in rising time order. */
export class Curve {
    private cursor = 0;

    constructor(
        private readonly points: [number, number][],
        private readonly hold = false
    ) {}

    at(seconds: number): number {
        const points = this.points;

        if (points.length === 0) {
            return 0;
        }

        if (this.cursor > 0 && points[this.cursor][0] > seconds) {
            this.cursor = 0;
        }

        while (this.cursor < points.length - 1 && points[this.cursor + 1][0] <= seconds) {
            this.cursor++;
        }

        const [t0, v0] = points[this.cursor];
        const next = points[this.cursor + 1];

        if (seconds <= t0 || next === undefined || this.hold) {
            return v0;
        }

        return v0 + ((next[1] - v0) * (seconds - t0)) / (next[0] - t0);
    }
}
