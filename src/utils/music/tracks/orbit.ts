// "Orbit": an original drum and bass track in F minor at 174 BPM. The notes first, then the sounds and the mix.
import { type Effects, type Lane, type Note, type Score, type Source, scoreSchema } from "../types";

const BPM = 174;
const STEP = 60 / BPM / 4;
const BAR = STEP * 16;
const INTRO = 0;
const BUILD = 8;
const DROP1 = 16;
const BREAK = 32;
const BUILD2 = 36;
const DROP2 = 40;
const OUTRO = 56;
const END = 62;

const names = [
    "kick",
    "snare",
    "ghost",
    "hat",
    "openHat",
    "breakKit",
    "cymbal",
    "ride",
    "roll",
    "sub",
    "reese",
    "pad",
    "stab",
    "piano",
    "voice",
    "arp",
    "sweep",
    "siren",
    "down",
    "impact",
] as const;
type PartName = (typeof names)[number];
const notes = Object.fromEntries(names.map((name) => [name, [] as Note[]])) as Record<PartName, Note[]>;

function put(part: PartName, bar: number, step: number, steps: number, midi: number, velocity: number) {
    notes[part].push({ at: bar * BAR + step * STEP, duration: steps * STEP, midi, velocity: Math.round(velocity) });
}

interface Chord {
    root: number;
    tones: number[];
}
const CHORDS: Chord[] = [
    { root: 29, tones: [53, 56, 60, 67] },
    { root: 37, tones: [49, 53, 56, 60] },
    { root: 32, tones: [56, 60, 63, 70] },
    { root: 39, tones: [51, 58, 63, 65] },
];
const chordAt = (bar: number) => CHORDS[Math.floor(bar / 2) % 4];

// The tune, eight bars: [bar, step, length in steps, pitch].
const TUNE: [number, number, number, number][] = [
    [0, 0, 6, 72],
    [0, 6, 4, 75],
    [0, 10, 14, 77],
    [1, 8, 4, 75],
    [1, 12, 4, 72],
    [2, 0, 6, 77],
    [2, 6, 4, 75],
    [2, 10, 14, 72],
    [3, 8, 4, 68],
    [3, 12, 4, 70],
    [4, 0, 6, 72],
    [4, 6, 4, 75],
    [4, 10, 14, 80],
    [5, 8, 4, 79],
    [5, 12, 4, 75],
    [6, 0, 6, 77],
    [6, 6, 4, 75],
    [6, 10, 10, 70],
    [7, 4, 4, 67],
    [7, 8, 4, 70],
    [7, 12, 4, 72],
];

function tune(part: PartName, start: number, bars: number, velocity: number, shift = 0) {
    for (const [bar, step, steps, midi] of TUNE) {
        if (bar < bars) {
            put(part, start + bar, step, steps + 0.4, midi + shift, velocity + (step === 0 ? 8 : 0));
        }
    }
}

function chords(part: PartName, bar: number, velocity: number, steps = 32) {
    if (bar % 2 === 0) {
        for (const midi of chordAt(bar).tones) {
            put(part, bar, 0, steps, midi, velocity);
        }
    }
}

function drums(bar: number, options: { fill?: boolean; hats?: boolean } = {}) {
    const turn = bar % 4 === 3;
    put("kick", bar, 0, 3, 36, 122);

    if (turn) {
        put("kick", bar, 6, 2, 36, 96);
    }

    if (!options.fill) {
        put("kick", bar, 10, 3, 36, 114);
        put("snare", bar, 4, 3, 38, 124);
        put("snare", bar, 12, 3, 38, 124);

        for (const [step, velocity] of bar % 2 === 0
            ? [
                  [7, 44],
                  [15, 52],
              ]
            : [
                  [9, 40],
                  [14, 46],
              ]) {
            put("ghost", bar, step, 1, 38, velocity);
        }
    } else {
        put("snare", bar, 4, 3, 38, 124);
        [8, 10, 12, 13, 14, 15].forEach((step, i) => {
            put("snare", bar, step, 1, 38, 80 + i * 8);
        });
    }

    for (let step = 0; step < 16; step++) {
        if (turn && step === 14) {
            put("openHat", bar, 14, 2, 46, 96);
        } else {
            put("hat", bar, step, 1, 42, step % 4 === 2 ? 112 : step % 2 === 0 ? 74 : 46);
        }
    }

    // A break played on the sampled kit under the main hits, for the shuffle of a real drummer.
    for (const step of [0, 2, 10, 11]) {
        put("breakKit", bar, step, 1, 36, step === 0 ? 100 : 78);
    }
    for (const [step, velocity] of [
        [4, 110],
        [7, 62],
        [9, 58],
        [12, 110],
        [15, 70],
    ]) {
        put("breakKit", bar, step, 1, 38, velocity);
    }
    for (let step = 0; step < 16; step += 2) {
        put("breakKit", bar, step, 1, step % 4 === 2 ? 46 : 42, 64);
    }
}

function bass(bar: number) {
    const { root } = chordAt(bar);
    const first = bar % 2 === 0;
    const line: [number, number, number][] = first
        ? [
              [0, 3, 0],
              [3, 3, 0],
              [6, 4, 0],
              [10, 4, 0],
              [14, 2, 0],
          ]
        : [
              [0, 6, 0],
              [6, 4, 0],
              [10, 2, 0],
              [12, 2, 12],
              [14, 2, 7],
          ];

    for (const [step, steps, shift] of line) {
        put("sub", bar, step, steps - 0.3, root + shift, 112);
    }

    const growl: [number, number, number, number][] = first
        ? [
              [0, 10.3, 12, 78],
              [10, 6.3, 12, 114],
          ]
        : [
              [0, 6.3, 12, 84],
              [6, 4.3, 12, 106],
              [10, 2.3, 24, 122],
              [12, 2.3, 19, 112],
              [14, 1.8, 12, 100],
          ];

    for (const [step, steps, shift, velocity] of growl) {
        put("reese", bar, step, steps, root + shift, velocity);
    }
}

function stabs(bar: number) {
    const { tones } = chordAt(bar);
    const hits = bar % 2 === 0 ? [0, 3, 6] : [0, 3, 6, 11, 14];

    for (const step of hits) {
        for (const midi of [...tones, tones[0] + 24]) {
            put("stab", bar, step, 2, midi, step === 0 ? 112 : 96);
        }
    }
}

function arp(bar: number) {
    const { tones } = chordAt(bar);
    const order = [0, 1, 2, 3, 2, 1, 2, 3];

    for (let step = 0; step < 16; step++) {
        put("arp", bar, step, 1, tones[order[step % 8]] + 12, step % 4 === 0 ? 96 : 68);
    }
}

function build(start: number, bars: number) {
    const total = bars * 16 - 4;
    const rates = [4, 4, 2, 2, 1, 1, 0.5];
    let step = 0;

    while (step < total) {
        const progress = step / total;
        const gap = rates[Math.min(rates.length - 1, Math.floor(progress * rates.length))];
        put("roll", start, step, gap, 50 + Math.round(progress * 14), 46 + progress * 78);
        step += gap;
    }

    put("sweep", start, 0, bars * 16 - 2, 60, 110);
    put("siren", start, 0, bars * 16 - 2, 41, 90);
}

// Intro: pad, piano and the tune.
for (let bar = INTRO; bar < BUILD; bar++) {
    chords("pad", bar, 86);
    chords("piano", bar, 62, 28);

    if (bar >= 4) {
        for (let step = 0; step < 16; step += 2) {
            put("hat", bar, step, 1, 42, step % 4 === 2 ? 84 : 50);
        }
    }
}
tune("voice", 4, 4, 84);

// Build: four on the floor, the roll, the risers.
for (let bar = BUILD; bar < DROP1; bar++) {
    chords("pad", bar, 92);
    chords("piano", bar, 70, 28);

    if (bar < DROP1 - 1) {
        for (const step of [0, 4, 8, 12]) {
            put("kick", bar, step, 3, 36, 104);
        }
    }

    for (let step = 0; step < 16; step += 2) {
        put("hat", bar, step, 1, 42, step % 4 === 2 ? 96 : 56);
    }
}
tune("voice", BUILD, 8, 92);
build(BUILD + 2, 6);

function drop(start: number, second: boolean) {
    for (let bar = start; bar < start + 16; bar++) {
        const last = bar === start + 15;
        drums(bar, { fill: bar === start + 7 || last });
        bass(bar);
        chords("pad", bar, 88);
        stabs(bar);

        if (second) {
            arp(bar);
            for (let step = 0; step < 16; step += bar >= start + 8 ? 2 : 4) {
                put("ride", bar, step, 2, 51, 74);
            }
        }
    }

    for (const bar of [start, start + 8]) {
        put("cymbal", bar, 0, 16, 49, 112);
        put("impact", bar, 0, 24, 36, bar === start ? 120 : 84);
    }

    put("down", start, 0, 28, 60, 110);
    tune("voice", start + (second ? 0 : 8), 8, 100);

    if (second) {
        tune("voice", start + 8, 8, 104);
        tune("arp", start + 8, 8, 84, 12);
    }
}

drop(DROP1, false);

// Breakdown: no drums, piano and the tune, then a short build.
for (let bar = BREAK; bar < DROP2; bar++) {
    chords("pad", bar, 90);
    chords("piano", bar, 84, 28);
    put("sub", bar, 0, 15.5, chordAt(bar).root, 84);
}
tune("voice", BREAK, 8, 88);
put("impact", BREAK, 0, 24, 36, 96);
put("cymbal", BREAK, 0, 16, 49, 90);
build(BUILD2, 4);

drop(DROP2, true);

// Outro: the tune once more, then the last chord.
for (let bar = OUTRO; bar < END - 2; bar++) {
    chords("pad", bar, 84);
    chords("piano", bar, 72, 28);

    for (let step = 0; step < 16; step += 2) {
        put("hat", bar, step, 1, 42, step % 4 === 2 ? 78 : 46);
    }
}
tune("voice", OUTRO, 4, 86);
put("impact", OUTRO, 0, 24, 36, 104);
put("cymbal", OUTRO, 0, 16, 49, 100);

for (const midi of CHORDS[0].tones) {
    put("pad", END - 2, 0, 30, midi, 80);
    put("piano", END - 2, 0, 30, midi, 76);
}
put("sub", END - 2, 0, 24, 29, 90);
put("impact", END - 2, 0, 24, 36, 90);

const synth = (patch: string): Source => ({ kind: "synth", patch });
const kit = (program: number): Source => ({ kind: "soundfont", program, percussion: true });
const pump = (depth: number, release = 150): Effects["duck"] => ({ by: ["kick", "snare"], depth, hold: 25, release });
const echo = (mix: number, feedback = 0.38): Effects["delay"] => ({
    time: STEP * 3,
    feedback,
    mix,
    pingPong: true,
    lowpass: 4800,
});
const t = (bar: number) => bar * BAR;

/** A value that rises through each build and falls back for the next one. */
function rises(from: number, to: number): [number, number][] {
    return [
        [t(BUILD + 2), from],
        [t(DROP1) - STEP * 4, to],
        [t(DROP1), from],
        [t(BUILD2), from],
        [t(DROP2) - STEP * 4, to],
    ];
}

function falls(from: number, to: number): [number, number][] {
    return [DROP1, DROP2].flatMap((bar): [number, number][] => [
        [t(bar), from],
        [t(bar) + STEP * 28, to],
    ]);
}

const setup: Record<PartName, { source: Source; pan?: number; effects: Effects; lanes?: Lane[] }> = {
    kick: {
        source: synth("kick"),
        effects: {
            highpass: 28,
            eq: [
                { type: "peak", frequency: 62, gain: 2, q: 1 },
                { type: "peak", frequency: 320, gain: -3, q: 1.2 },
            ],
            drive: { amount: 3 },
            gain: 1,
        },
    },
    snare: {
        source: synth("snare"),
        effects: {
            highpass: 130,
            eq: [
                { type: "peak", frequency: 200, gain: 2.5, q: 1.3 },
                { type: "highshelf", frequency: 6000, gain: 4 },
            ],
            compressor: { threshold: -12, ratio: 3, attack: 6, release: 80, makeup: 2 },
            reverb: 0.14,
            gain: -10,
        },
    },
    ghost: { source: synth("snare"), effects: { highpass: 180, reverb: 0.1, gain: -8 } },
    hat: { source: synth("hat"), pan: 72, effects: { highpass: 6500, gain: -8 } },
    openHat: { source: synth("openHat"), pan: 56, effects: { highpass: 5000, gain: -9 } },
    breakKit: {
        source: kit(8),
        effects: {
            highpass: 320,
            drive: { amount: 9 },
            compressor: { threshold: -20, ratio: 4, attack: 3, release: 60, makeup: 3 },
            reverb: 0.08,
            gain: 4,
        },
    },
    cymbal: { source: kit(0), effects: { highpass: 400, reverb: 0.3, gain: 0 } },
    ride: { source: kit(0), pan: 76, effects: { highpass: 2500, gain: 7 } },
    roll: { source: synth("roll"), effects: { highpass: 150, reverb: 0.25, gain: -9 } },
    sub: {
        source: synth("sub"),
        effects: { lowpass: 150, duck: { by: ["kick"], depth: 0.92, hold: 30, release: 110 }, gain: -10 },
    },
    reese: {
        source: synth("reese"),
        effects: {
            highpass: 110,
            eq: [{ type: "peak", frequency: 900, gain: 3, q: 1 }],
            drive: { amount: 8 },
            lowpass: 6500,
            width: 1.2,
            monoBelow: 220,
            duck: pump(0.8, 140),
            gain: -14,
        },
    },
    pad: {
        source: synth("pad"),
        effects: { highpass: 260, width: 1.2, duck: pump(0.75, 190), reverb: 0.45, gain: -16 },
        lanes: [
            {
                target: "lowpass",
                points: [
                    [0, 350],
                    [t(BUILD), 1200],
                    [t(DROP1) - 0.01, 5000],
                    [t(DROP1), 9000],
                    [t(OUTRO), 9000],
                    [t(END), 500],
                ],
            },
        ],
    },
    stab: {
        source: synth("stab"),
        effects: {
            highpass: 260,
            eq: [{ type: "highshelf", frequency: 5000, gain: 5 }],
            delay: echo(0.2),
            width: 1.2,
            duck: pump(0.7),
            reverb: 0.3,
            gain: -14,
        },
    },
    piano: {
        source: { kind: "soundfont", program: 0, percussion: false },
        effects: { highpass: 180, duck: pump(0.5), reverb: 0.4, gain: 5 },
    },
    voice: {
        source: synth("voice"),
        effects: {
            highpass: 260,
            eq: [{ type: "peak", frequency: 2500, gain: 2, q: 1 }],
            delay: echo(0.28, 0.42),
            duck: pump(0.45),
            reverb: 0.45,
            gain: -7,
        },
    },
    arp: {
        source: synth("pluck"),
        pan: 84,
        effects: { highpass: 320, delay: echo(0.3, 0.4), duck: pump(0.5), reverb: 0.35, gain: -11 },
    },
    sweep: {
        source: synth("sweep"),
        effects: { highpass: 300, width: 1.3, reverb: 0.3, gain: -12 },
        lanes: [
            { target: "cutoff", points: rises(0, 5.5) },
            { target: "level", points: rises(-26, 0) },
        ],
    },
    siren: {
        source: synth("siren"),
        effects: { highpass: 250, reverb: 0.3, gain: -19 },
        lanes: [
            { target: "pitch", points: rises(0, 24) },
            { target: "level", points: rises(-24, 0) },
        ],
    },
    down: {
        source: synth("sweep"),
        effects: { reverb: 0.3, gain: -13 },
        lanes: [
            { target: "cutoff", points: falls(5.5, 0) },
            { target: "level", points: falls(0, -30) },
        ],
    },
    impact: { source: synth("impact"), effects: { reverb: 0.5, gain: -7 } },
};

const parts = names.map((name) => ({
    name,
    source: setup[name].source,
    volume: 127,
    pan: setup[name].pan,
    notes: notes[name],
    effects: setup[name].effects,
    lanes: setup[name].lanes,
}));

/** An original drum and bass track: synthesized drums and basses, sidechain, one room, and a limited master. */
export function orbitScore(): Score {
    return scoreSchema.parse({
        key: "Orbit",
        title: "Orbit",
        bpm: BPM,
        seconds: t(END) + 4,
        end: t(END) + 2,
        parts,
        room: { size: 0.82, damp: 0.35, predelay: 18, highpass: 280, lowpass: 9000, level: -2 },
        master: { lufs: -9, peak: -1, limiter: true, clip: 3 },
    });
}
