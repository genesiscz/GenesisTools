// Copied from the Kalendora repository, video/scripts/taps.ts, at commit 481f90467dafdc609cfc834993855299b7410f94
const Rate = 48000;
export const CHOSEN_TAP = "09-down-up";
let seed = 7;
const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 2 ** 32) * 2 - 1;
};
/** A sine whose pitch falls from f0 to f1 (rate k), with a soft attack (seconds) and an exponential decay d. */
const thump =
    (f0: number, f1: number, k: number, d: number, attack = 0.002) =>
    (t: number) =>
        Math.sin(2 * Math.PI * (f1 * t + ((f0 - f1) * (1 - Math.exp(-k * t))) / k)) *
        (1 - Math.exp(-t / attack)) *
        Math.exp(-d * t);
/** Noise through a one-pole low-pass at `cut` Hz, with decay d. */
const hush = (cut: number, d: number, attack = 0.001) => {
    let y = 0;
    const a = 1 - Math.exp((-2 * Math.PI * cut) / Rate);
    return (t: number) => {
        y += a * (rand() - y);
        return y * 3 * (1 - Math.exp(-t / attack)) * Math.exp(-d * t);
    };
};
const mix =
    (...parts: [number, (t: number) => number][]) =>
    (t: number) =>
        parts.reduce((s, [g, f]) => s + g * f(t), 0);
const later = (delay: number, f: (t: number) => number) => (t: number) => (t < delay ? 0 : f(t - delay));
/** Name, what it is, and the wave. A wave with noise keeps state, so each entry builds its own. */
export const TAPS: [string, string, () => (t: number) => number][] = [
    ["01-thump", "low thump, 170 to 85 Hz", () => thump(170, 85, 60, 55)],
    ["02-deep", "deeper and longer, 130 to 60 Hz", () => thump(130, 60, 40, 38, 0.003)],
    ["03-pad", "finger pad: muffled noise only", () => hush(350, 70)],
    ["04-pad-body", "finger pad with a low body", () => mix([0.7, hush(500, 80)], [0.8, thump(160, 100, 50, 60)])],
    ["05-wood", "soft wood knock, 300 Hz", () => mix([1, thump(320, 290, 30, 75)], [0.25, thump(640, 600, 30, 110)])],
    [
        "06-glass",
        "fingertip on glass: short and a little brighter",
        () => mix([0.6, hush(1400, 160)], [0.6, thump(260, 180, 80, 90)]),
    ],
    [
        "07-felt",
        "felt: two close tones, very soft attack",
        () => mix([0.7, thump(220, 200, 30, 55, 0.005)], [0.5, thump(330, 300, 30, 70, 0.005)]),
    ],
    ["08-pop", "muted pop, 380 falling to 140 Hz", () => thump(380, 140, 140, 70)],
    [
        "09-down-up",
        "press and release: two soft thumps",
        () => mix([1, thump(170, 90, 60, 65)], [0.55, later(0.085, thump(210, 120, 60, 80))]),
    ],
    ["10-tick", "the quietest: a tiny dull tick", () => mix([0.5, hush(900, 220)], [0.5, thump(200, 150, 90, 130)])],
];
export function wav(samples: Float32Array): Buffer {
    const b = Buffer.alloc(44 + samples.length * 2);
    b.write("RIFF", 0);
    b.writeUInt32LE(36 + samples.length * 2, 4);
    b.write("WAVEfmt ", 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(Rate, 24);
    b.writeUInt32LE(Rate * 2, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36);
    b.writeUInt32LE(samples.length * 2, 40);
    samples.forEach((s, i) => {
        b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2);
    });
    return b;
}
const Peak = 0.35; // about -9 dBFS, the same for every tap

function samplesOf(wave: () => (t: number) => number): Float32Array {
    seed = 7; // the same noise on every run
    const f = wave();
    const s = new Float32Array(Math.round(Rate * 0.3));
    for (let i = 0; i < s.length; i++) {
        s[i] = f(i / Rate);
    }
    const fade = Math.round(Rate * 0.02);
    for (let i = 0; i < fade; i++) {
        s[s.length - 1 - i]! *= i / fade;
    }
    const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    for (let i = 0; i < s.length; i++) {
        s[i] = (s[i]! / peak) * Peak;
    }
    return s;
}

export function tapAudio(key: string = CHOSEN_TAP): Buffer {
    const tap = TAPS.find(([name]) => name === key);

    if (!tap) {
        throw new Error(`Unknown tap: ${key}`);
    }

    return wav(samplesOf(tap[2]));
}

export function tapAudition(): Buffer {
    const all = new Float32Array(Math.round(Rate * (TAPS.length * 2.4 + 0.5)));

    TAPS.forEach((tap, index) => {
        const samples = samplesOf(tap[2]);
        [0, 0.45, 0.9].forEach((at) => {
            all.set(samples, Math.round(Rate * (index * 2.4 + at)));
        });
    });

    return wav(all);
}
