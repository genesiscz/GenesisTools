// "Halo": an original melodic trap track in B flat minor at 110 BPM: big saw chords that pump under the kick, an
// 808 bass, trap hats and a lead in place of a singer. The notes first, then the sounds and the mix.
import { grid, type PartSetup } from "../compose";
import { type Effects, type Score, type Source, scoreSchema } from "../types";

const BPM = 110;
const INTRO = 0;
const VERSE = 4;
const PRE = 12;
const DROP1 = 20;
const BREAK = 36;
const VERSE2 = 40;
const BUILD2 = 48;
const DROP2 = 52;
const OUTRO = 68;
const END = 72;

const names = [
    "kick",
    "kickHit",
    "snare",
    "snareHit",
    "clap",
    "rim",
    "hat",
    "openHat",
    "cymbal",
    "roll",
    "bass",
    "saws",
    "pad",
    "piano",
    "guitar",
    "lead",
    "bell",
    "sweep",
    "siren",
    "down",
    "impact",
] as const;
type PartName = (typeof names)[number];
const track = grid(BPM, names);
const { step: STEP, notes, put, at: t } = track;

interface Chord {
    /** The 808 note. */
    root: number;
    tones: number[];
}
// One chord a bar: G flat major seven, A flat with a nine, B flat minor seven, D flat over F.
const CHORDS: Chord[] = [
    { root: 30, tones: [54, 58, 61, 65, 70] },
    { root: 32, tones: [56, 60, 63, 70] },
    { root: 34, tones: [58, 61, 65, 68] },
    { root: 25, tones: [53, 56, 61, 65, 68] },
];
const chordAt = (bar: number) => CHORDS[bar % 4];

type Tune = [bar: number, step: number, steps: number, midi: number][];
// The lead of a drop, eight bars.
const HOOK: Tune = [
    [0, 0, 3, 77],
    [0, 3, 3, 80],
    [0, 6, 2, 77],
    [0, 8, 4, 75],
    [0, 12, 2, 73],
    [0, 14, 2, 75],
    [1, 0, 3, 75],
    [1, 3, 3, 72],
    [1, 6, 2, 75],
    [1, 8, 6, 80],
    [1, 14, 2, 82],
    [2, 0, 3, 85],
    [2, 3, 3, 82],
    [2, 6, 2, 80],
    [2, 8, 4, 77],
    [2, 12, 4, 80],
    [3, 0, 6, 80],
    [3, 6, 2, 77],
    [3, 8, 3, 75],
    [3, 11, 3, 73],
    [3, 14, 2, 70],
    [4, 0, 3, 77],
    [4, 3, 3, 80],
    [4, 6, 2, 77],
    [4, 8, 4, 82],
    [4, 12, 2, 80],
    [4, 14, 2, 77],
    [5, 0, 3, 75],
    [5, 3, 3, 80],
    [5, 6, 2, 75],
    [5, 8, 6, 84],
    [5, 14, 2, 82],
    [6, 0, 3, 85],
    [6, 3, 3, 82],
    [6, 6, 2, 85],
    [6, 8, 4, 89],
    [6, 12, 4, 85],
    [7, 0, 6, 85],
    [7, 6, 2, 82],
    [7, 8, 8, 80],
];
// The line of a verse, eight bars, where a singer would be.
const LINE: Tune = [
    [0, 2, 2, 65],
    [0, 4, 2, 68],
    [0, 6, 4, 70],
    [0, 12, 4, 68],
    [1, 2, 2, 63],
    [1, 4, 2, 68],
    [1, 6, 6, 72],
    [2, 2, 2, 73],
    [2, 4, 2, 72],
    [2, 6, 4, 70],
    [2, 12, 4, 68],
    [3, 0, 6, 65],
    [3, 8, 6, 68],
    [4, 2, 2, 65],
    [4, 4, 2, 68],
    [4, 6, 4, 70],
    [4, 12, 4, 73],
    [5, 2, 2, 75],
    [5, 4, 2, 72],
    [5, 6, 6, 68],
    [6, 2, 2, 70],
    [6, 4, 2, 73],
    [6, 6, 4, 77],
    [6, 12, 4, 75],
    [7, 0, 8, 73],
    [7, 8, 6, 72],
];

function tune(
    part: PartName,
    notesOf: Tune,
    start: number,
    options: { bars?: number; velocity: number; shift?: number }
) {
    for (const [bar, step, steps, midi] of notesOf) {
        if (bar < (options.bars ?? 8)) {
            put(
                part,
                start + bar,
                step,
                steps - 0.2,
                midi + (options.shift ?? 0),
                options.velocity + (step === 0 ? 8 : 0)
            );
        }
    }
}

function held(part: PartName, bar: number, velocity: number, steps = 16) {
    for (const midi of chordAt(bar).tones) {
        put(part, bar, 0, steps - 0.3, midi, velocity);
    }
}

/** Piano chords on a dotted rhythm. */
function piano(bar: number, velocity: number) {
    for (const [step, steps] of [
        [0, 6],
        [6, 5],
        [11, 5],
    ]) {
        for (const midi of chordAt(bar).tones) {
            put("piano", bar, step, steps, midi, step === 0 ? velocity : velocity - 14);
        }
    }
}

function guitar(bar: number, velocity: number) {
    const { tones } = chordAt(bar);
    const order = [0, 2, 1, 3, 2, 1, 3, 2];

    for (let n = 0; n < 8; n++) {
        put("guitar", bar, n * 2, 3, tones[order[n] % tones.length] + 12, n % 4 === 0 ? velocity + 12 : velocity);
    }
}

/** Hats: eighths, with a run of sixteenths on the last beat of odd bars and a fast roll before each fourth bar. */
function hats(bar: number, velocity: number, busy = false) {
    for (let step = 0; step < 16; step += busy ? 1 : 2) {
        if (bar % 2 === 1 && step === 14) {
            put("openHat", bar, 14, 2, 60, velocity);
        } else {
            put("hat", bar, step, 1, 60, step % 4 === 2 ? velocity : step % 2 === 0 ? velocity - 20 : velocity - 36);
        }
    }

    if (!busy && bar % 2 === 1) {
        put("hat", bar, 13, 1, 60, velocity - 36);
    }

    if (bar % 4 === 2) {
        for (let n = 0; n < 6; n++) {
            put("hat", bar, 12 + n * (2 / 3), 0.6, 60, velocity - 44 + n * 7);
        }
    }

    if (bar % 4 === 0) {
        for (const step of [6.5, 7, 7.5]) {
            put("hat", bar, step, 0.5, 60, velocity - 40);
        }
    }
}

const KICKS = [
    [0, 3, 7, 13],
    [0, 3, 6, 10, 13],
];

function dropBar(bar: number, index: number, second: boolean) {
    const { root, tones } = chordAt(bar);
    const fill = index % 4 === 3;
    const kicks = KICKS[index % 2].filter((step) => !fill || step < 12);

    kicks.forEach((step, n) => {
        const next = kicks[n + 1] ?? (fill ? 12 : 16);
        put("kick", bar, step, 2, 36, step === 0 ? 124 : 108);
        put("bass", bar, step, next - step - 0.25, root, step === 0 ? 120 : 108);
    });

    // The last 808 note of a phrase slides up an octave.
    if (index % 8 === 6) {
        put("bass", bar, 14.75, 1.2, root + 12, 104);
    }

    put("snare", bar, 8, 4, 38, 126);

    if (fill) {
        for (const [step, steps] of [
            [12, 1],
            [13, 1],
            [14, 0.5],
            [14.5, 0.5],
            [15, 0.5],
            [15.5, 0.5],
        ]) {
            put("snare", bar, step, steps, 38, 78 + (step - 12) * 11);
        }
    } else if (index % 2 === 1) {
        put("snare", bar, 15, 1, 38, 58);
    }

    hats(bar, 104, second && index >= 8);

    // Chords come again on a dotted rhythm; the kick ducks them, which is the pump.
    for (const [step, steps] of [
        [0, 3],
        [3, 3],
        [6, 2],
        [8, 3],
        [11, 3],
        [14, 2],
    ]) {
        if (!fill || step < 12) {
            for (const midi of [...tones, tones[tones.length - 1] + 12]) {
                put("saws", bar, step, steps - 0.3, midi, step === 0 ? 116 : 100);
            }
        }
    }
}

function drop(start: number, second: boolean) {
    for (let index = 0; index < 16; index++) {
        dropBar(start + index, index, second);
    }

    for (const bar of [start, start + 8]) {
        put("cymbal", bar, 0, 16, 49, 110);
        put("impact", bar, 0, 16, 36, bar === start ? 118 : 86);
    }

    put("down", start, 0, 20, 60, 110);
    tune("lead", HOOK, start, { velocity: 108 });
    tune("lead", HOOK, start + 8, { velocity: 112 });
    tune("bell", HOOK, start + 8, { velocity: 92, shift: 12 });

    if (second) {
        tune("bell", HOOK, start, { velocity: 86, shift: 12 });
    }
}

function build(start: number, bars: number) {
    const total = bars * 16 - 8;
    const rates = [4, 4, 2, 2, 1, 1, 0.5];
    let step = 0;

    while (step < total) {
        const progress = step / total;
        const gap = rates[Math.min(rates.length - 1, Math.floor(progress * rates.length))];
        put("roll", start, step, gap, 50 + Math.round(progress * 14), 46 + progress * 78);
        step += gap;
    }

    put("sweep", start, 0, total, 60, 110);
    put("siren", start, 0, total, 46, 90);
}

function verse(start: number, full: boolean) {
    for (let bar = start; bar < start + 8; bar++) {
        const late = bar >= start + 4;
        const { root } = chordAt(bar);
        held("pad", bar, 80);
        piano(bar, 78);
        guitar(bar, 76);
        put("kick", bar, 0, 2, 36, 54);
        // In a verse the bass plays high, where a bass guitar would be, and leaves the sub to the drop.
        put("bass", bar, 0, full ? 9 : 6, root < 28 ? root + 24 : root + 12, 36);
        put("rim", bar, 8, 1, 60, 96);
        put("clap", bar, 8, 2, 60, late || full ? 88 : 64);

        if (full || late) {
            put("kick", bar, 10, 2, 36, 50);
            hats(bar, 100);
        }
    }

    tune("lead", LINE, start, { velocity: 112 });
}

// Intro: pad, piano and guitar, and the end of the verse line.
for (let bar = INTRO; bar < VERSE; bar++) {
    held("pad", bar, 62);
    piano(bar, 52);

    if (bar >= 2) {
        guitar(bar, 50);
    }
}

verse(VERSE, false);

// Before the drop: the saws come in dark and open, claps, then four bars of build.
for (let bar = PRE; bar < DROP1; bar++) {
    const last = bar === DROP1 - 1;
    held("saws", bar, bar < PRE + 4 ? 44 : 56, last ? 8 : 16);
    held("pad", bar, 70);
    piano(bar, 64);
    put("bass", bar, 0, last ? 7 : 13, chordAt(bar).root, bar < PRE + 4 ? 40 : 52);

    if (!last) {
        for (const step of bar < PRE + 4 ? [0, 6, 10] : [0, 4, 8, 12]) {
            put("kick", bar, step, 2, 36, bar < PRE + 4 ? 62 : 80);
        }

        put("clap", bar, 8, 2, 60, bar < PRE + 4 ? 80 : 92);
        hats(bar, 88);
    }
}
tune("lead", LINE, PRE, { velocity: 100, shift: 12 });
build(PRE + 4, 4);

drop(DROP1, false);

// Break: only the pad, the piano and the tail of the drop.
for (let bar = BREAK; bar < VERSE2; bar++) {
    held("pad", bar, 66);
    piano(bar, 56);
}
put("impact", BREAK, 0, 16, 36, 84);
put("cymbal", BREAK, 0, 16, 49, 88);

verse(VERSE2, true);
tune("bell", LINE, VERSE2 + 4, { bars: 4, velocity: 70, shift: 12 });

for (let bar = BUILD2; bar < DROP2; bar++) {
    const last = bar === DROP2 - 1;
    held("saws", bar, 84, last ? 8 : 16);
    piano(bar, 72);
    put("bass", bar, 0, last ? 7 : 13, chordAt(bar).root, 70);

    if (!last) {
        for (const step of [0, 4, 8, 12]) {
            put("kick", bar, step, 2, 36, 108);
        }

        put("clap", bar, 8, 2, 60, 104);
    }
}
build(BUILD2, 4);

drop(DROP2, true);

// Outro: pad, piano and guitar, then the first chord once more.
for (let bar = OUTRO; bar < END - 2; bar++) {
    held("pad", bar, 64);
    piano(bar, 56);
    guitar(bar, 50);
}
tune("lead", LINE, OUTRO, { bars: 2, velocity: 84 });
put("impact", OUTRO, 0, 16, 36, 98);
put("cymbal", OUTRO, 0, 16, 49, 96);

for (const midi of CHORDS[0].tones) {
    put("pad", END - 2, 0, 28, midi, 62);
    put("piano", END - 2, 0, 28, midi, 58);
}

// The recorded hits play the same notes as the synth drums they are layered with.
notes.kickHit = notes.kick;
notes.snareHit = notes.snare;
notes.clap = [...notes.clap, ...notes.snare.filter((note) => note.velocity > 120)];

const synth = (patch: string): Source => ({ kind: "synth", patch });
const sample = (file: string): Source => ({ kind: "sample", file, mode: "hit", root: 60, slices: 16, speed: 1 });
const pump = (depth: number, release = 260): Effects["duck"] => ({ by: ["kick", "snare"], depth, hold: 35, release });
const echo = (mix: number, feedback = 0.4): Effects["delay"] => ({
    time: STEP * 3,
    feedback,
    mix,
    pingPong: true,
    lowpass: 5200,
});
const BUILDS: [from: number, to: number][] = [
    [PRE + 4, DROP1],
    [BUILD2, DROP2],
];

/** A value that rises through each build and falls back for the next one. */
function rises(from: number, to: number): [number, number][] {
    return BUILDS.flatMap(([start, end]): [number, number][] => [
        [t(start), from],
        [t(end) - STEP * 8, to],
        [t(end), from],
    ]);
}

function falls(from: number, to: number): [number, number][] {
    return [DROP1, DROP2].flatMap((bar): [number, number][] => [
        [t(bar), from],
        [t(bar) + STEP * 20, to],
    ]);
}

const setup: Record<PartName, PartSetup> = {
    kick: {
        source: synth("kick"),
        effects: {
            highpass: 45,
            eq: [
                { type: "peak", frequency: 95, gain: 3, q: 1 },
                { type: "peak", frequency: 3500, gain: 3, q: 1 },
            ],
            drive: { amount: 4 },
            gain: -3,
        },
    },
    kickHit: {
        source: sample("sonic-pi/bd_haus.flac"),
        effects: { highpass: 60, drive: { amount: 4 }, gain: -5 },
    },
    snare: {
        source: synth("snare"),
        effects: {
            highpass: 130,
            eq: [
                { type: "peak", frequency: 200, gain: 3, q: 1.2 },
                { type: "highshelf", frequency: 6000, gain: 6 },
            ],
            compressor: { threshold: -12, ratio: 3, attack: 6, release: 90, makeup: 2 },
            reverb: 0.25,
            gain: -8,
        },
    },
    snareHit: {
        source: sample("tr808/sd8/SD5050.WAV"),
        effects: { highpass: 140, eq: [{ type: "highshelf", frequency: 5000, gain: 3 }], reverb: 0.25, gain: -5 },
    },
    clap: { source: sample("tr808/cp8/CP.WAV"), effects: { highpass: 400, width: 1.1, reverb: 0.3, gain: -1 } },
    rim: { source: sample("tr808/rs8/RS.WAV"), pan: 52, effects: { highpass: 300, reverb: 0.3, gain: -9 } },
    hat: { source: sample("tr808/ch8/CH.WAV"), pan: 70, effects: { highpass: 6000, gain: 3 } },
    openHat: { source: sample("tr808/oh8/OH25.WAV"), pan: 58, effects: { highpass: 5000, gain: -6 } },
    cymbal: {
        source: { kind: "soundfont", program: 0, percussion: true },
        effects: { highpass: 400, reverb: 0.3, gain: 0 },
    },
    roll: { source: synth("roll"), effects: { highpass: 150, reverb: 0.3, gain: -10 } },
    bass: {
        source: synth("bass808"),
        effects: {
            lowpass: 2500,
            eq: [{ type: "peak", frequency: 130, gain: 3, q: 1 }],
            drive: { amount: 10 },
            duck: { by: ["kick"], depth: 0.75, hold: 20, release: 90 },
            gain: -7,
        },
        // The 808's drive flattens note velocity, so the quiet sections are set here, ahead of the drive.
        lanes: [
            {
                target: "level",
                hold: true,
                points: [
                    [0, -12],
                    [t(PRE), -9],
                    [t(PRE + 4), -4],
                    [t(DROP1), 0],
                    [t(VERSE2), -12],
                    [t(BUILD2), -4],
                    [t(DROP2), 0],
                ],
            },
        ],
    },
    saws: {
        source: synth("supersaw"),
        effects: {
            highpass: 260,
            eq: [
                { type: "peak", frequency: 600, gain: -4, q: 0.7 },
                { type: "peak", frequency: 2200, gain: 4, q: 0.7 },
                { type: "highshelf", frequency: 6500, gain: 5 },
            ],
            width: 1,
            duck: pump(0.9),
            reverb: 0.2,
            gain: -9,
        },
        lanes: [
            {
                target: "lowpass",
                points: [
                    [0, 500],
                    [t(PRE), 500],
                    [t(DROP1) - STEP * 8, 7000],
                    [t(DROP1), 15000],
                    [t(BUILD2), 600],
                    [t(DROP2) - STEP * 8, 7000],
                    [t(DROP2), 15000],
                ],
            },
        ],
    },
    pad: {
        source: synth("pad"),
        effects: { highpass: 220, width: 0.9, duck: pump(0.85), reverb: 0.35, gain: -15 },
        lanes: [
            {
                target: "lowpass",
                points: [
                    [0, 700],
                    [t(VERSE), 3500],
                    [t(PRE), 5000],
                    [t(DROP1), 6000],
                    [t(BREAK), 3000],
                    [t(DROP2), 6000],
                    [t(OUTRO), 2000],
                    [t(END), 500],
                ],
            },
        ],
    },
    piano: {
        source: { kind: "soundfont", program: 0, percussion: false },
        effects: {
            highpass: 160,
            eq: [{ type: "highshelf", frequency: 3500, gain: 4 }],
            duck: pump(0.4),
            reverb: 0.3,
            gain: 2,
        },
    },
    guitar: {
        source: { kind: "soundfont", program: 24, percussion: false },
        pan: 40,
        effects: {
            highpass: 200,
            eq: [{ type: "highshelf", frequency: 4000, gain: 5 }],
            delay: echo(0.2),
            reverb: 0.4,
            gain: 4,
        },
    },
    lead: {
        source: synth("voice"),
        effects: {
            highpass: 450,
            eq: [
                { type: "peak", frequency: 800, gain: -4, q: 1 },
                { type: "peak", frequency: 2600, gain: 4, q: 1 },
                { type: "highshelf", frequency: 6000, gain: 3 },
            ],
            delay: echo(0.2, 0.36),
            duck: pump(0.35),
            reverb: 0.3,
            gain: -7,
        },
    },
    bell: {
        source: synth("pluck"),
        pan: 76,
        effects: { highpass: 500, delay: echo(0.3, 0.45), duck: pump(0.35), reverb: 0.4, gain: -8 },
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
        effects: { reverb: 0.3, gain: -14 },
        lanes: [
            { target: "cutoff", points: falls(5.5, 0) },
            { target: "level", points: falls(0, -30) },
        ],
    },
    impact: { source: synth("impact"), effects: { highpass: 60, reverb: 0.5, gain: -8 } },
};

/** An original melodic trap track: saw chords that pump under the kick, an 808 bass, trap hats and a lead. */
export function haloScore(): Score {
    return scoreSchema.parse({
        key: "Halo",
        title: "Halo",
        bpm: BPM,
        seconds: t(END) + 4,
        end: t(END) + 2,
        parts: track.parts(setup),
        room: { size: 0.8, damp: 0.35, predelay: 20, highpass: 300, lowpass: 9000, level: -4.5 },
        master: { lufs: -8, peak: -1, limiter: true, clip: 3 },
    });
}
