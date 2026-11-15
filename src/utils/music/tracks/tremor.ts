// "Tremor": an original dubstep track in E minor at 140 BPM with half-time drums. The notes first, then the
// sounds and the mix.
import { grid, type PartSetup } from "../compose";
import { type Effects, type Lane, type Score, type Source, scoreSchema } from "../types";

const BPM = 140;
const BEAT_HZ = BPM / 60;
const INTRO = 0;
const BUILD = 8;
const DROP1 = 16;
const BREAK = 32;
const BUILD2 = 40;
const DROP2 = 44;
const OUTRO = 60;
const END = 66;

const names = [
    "kick",
    "kickHit",
    "snare",
    "snareHit",
    "clap",
    "hat",
    "hatHit",
    "openHat",
    "cymbal",
    "roll",
    "sub",
    "wobble",
    "growl",
    "pad",
    "stab",
    "pluck",
    "lead",
    "sweep",
    "siren",
    "down",
    "impact",
    "boom",
    "dive",
    "rewind",
] as const;
type PartName = (typeof names)[number];
const track = grid(BPM, names);
const { step: STEP, notes, put, at: t } = track;

interface Chord {
    /** The sub note. The mid basses play it an octave up. */
    root: number;
    tones: number[];
}
const CHORDS: Chord[] = [
    { root: 28, tones: [52, 55, 59, 64] },
    { root: 36, tones: [48, 55, 60, 64] },
    { root: 31, tones: [55, 59, 62, 67] },
    { root: 38, tones: [50, 57, 62, 66] },
];
const chordAt = (bar: number) => CHORDS[Math.floor(bar / 2) % 4];
/** The drops stay low: two phrases on E, then G, then A. */
const DROP_ROOTS = [28, 28, 31, 33];

// The tune, eight bars: [bar, step, length in steps, pitch].
const TUNE: [number, number, number, number][] = [
    [0, 0, 6, 71],
    [0, 6, 2, 74],
    [0, 8, 8, 76],
    [1, 0, 4, 74],
    [1, 4, 4, 71],
    [1, 8, 8, 67],
    [2, 0, 6, 72],
    [2, 6, 2, 71],
    [2, 8, 8, 67],
    [3, 0, 4, 64],
    [3, 4, 4, 67],
    [3, 8, 8, 69],
    [4, 0, 6, 71],
    [4, 6, 2, 74],
    [4, 8, 8, 79],
    [5, 0, 4, 78],
    [5, 4, 4, 74],
    [5, 8, 8, 71],
    [6, 0, 6, 69],
    [6, 6, 2, 71],
    [6, 8, 8, 74],
    [7, 0, 8, 66],
    [7, 8, 8, 69],
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

function arp(bar: number, velocity: number) {
    const { tones } = chordAt(bar);
    const order = [0, 1, 2, 3, 2, 1, 2, 1];

    for (let n = 0; n < 8; n++) {
        put("pluck", bar, n * 2, 2, tones[order[n]] + 12, n % 4 === 0 ? velocity + 14 : velocity);
    }
}

/**
 * One bass note of a drop bar. A wobble note names how many times the filter opens in one beat. A growl note
 * names the vowel it starts on and the vowel it ends on (0 a, 1 e, 2 i, 3 o).
 */
type Riff =
    | { voice: "wobble"; step: number; steps: number; shift: number; perBeat: number }
    | { voice: "growl"; step: number; steps: number; shift: number; from: number; to: number };
const wob = (step: number, steps: number, shift: number, perBeat: number): Riff => ({
    voice: "wobble",
    step,
    steps,
    shift,
    perBeat,
});
const talk = (step: number, steps: number, shift: number, from: number, to: number): Riff => ({
    voice: "growl",
    step,
    steps,
    shift,
    from,
    to,
});
const RIFFS = {
    call: [wob(0, 4, 0, 1), wob(4, 4, 0, 2), wob(8, 4, 0, 3), talk(12, 2, 12, 2, 3), talk(14, 2, 10, 3, 0)],
    answer: [talk(0, 3, 0, 0, 2), talk(3, 3, 0, 2, 0), wob(6, 2, 3, 4), wob(8, 6, 0, 4), wob(14, 2, 7, 8)],
    climb: [wob(0, 6, 0, 2), talk(6, 2, 12, 3, 1), talk(8, 2, 0, 0, 3), talk(10, 2, 0, 3, 0), wob(12, 4, 0, 6)],
    turn: [talk(0, 2, 0, 0, 2), talk(2, 2, 0, 2, 0), wob(4, 4, 0, 3), wob(8, 4, -2, 4)],
} satisfies Record<string, Riff[]>;
type RiffName = keyof typeof RIFFS;
const wobbleRate: [number, number][] = [];
const growlVowel: [number, number][] = [];

function bass(bar: number, root: number, riff: RiffName) {
    for (const note of RIFFS[riff]) {
        const at = t(bar) + note.step * STEP;
        const midi = root + 12 + note.shift;
        put("sub", bar, note.step, note.steps - 0.3, root + (note.shift === 12 ? 0 : note.shift), 112);
        put(note.voice, bar, note.step, note.steps - 0.25, midi, 112);

        if (note.voice === "wobble") {
            wobbleRate.push([at, BEAT_HZ * note.perBeat]);
        } else {
            growlVowel.push([at, note.from], [at + (note.steps - 0.4) * STEP, note.to]);
        }
    }
}

function drums(bar: number, options: { fill?: boolean; busy?: boolean } = {}) {
    const kicks = options.fill ? [0, 6] : bar % 4 === 3 ? [0, 6, 10, 14] : bar % 2 === 0 ? [0, 10] : [0, 3, 10];

    for (const step of kicks) {
        put("kick", bar, step, 3, 36, step === 0 ? 124 : 104);
    }

    put("snare", bar, 8, 4, 38, 126);

    if (options.fill) {
        for (const [step, steps] of [
            [12, 1],
            [13, 1],
            [14, 0.5],
            [14.5, 0.5],
            [15, 0.5],
            [15.5, 0.5],
        ]) {
            put("snare", bar, step, steps, 38, 84 + (step - 12) * 10);
        }
    }

    const every = options.busy ? 1 : 2;

    for (let step = 0; step < 16; step += every) {
        if (bar % 2 === 1 && step === 14) {
            put("openHat", bar, 14, 2, 46, 98);
        } else {
            put("hat", bar, step, 1, 42, step % 4 === 2 ? 110 : step % 2 === 0 ? 72 : 48);
        }
    }

    // A fast run of hats into the next bar, as a drummer does on the last beat.
    if (bar % 4 === 1 && !options.busy) {
        for (const step of [12.5, 13, 13.5]) {
            put("hat", bar, step, 0.5, 42, 58);
        }
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

    put("sweep", start, 0, bars * 16 - 8, 60, 110);
    put("siren", start, 0, bars * 16 - 8, 40, 90);
}

// Intro: pad, plucks and a low note. Hats come in after four bars.
for (let bar = INTRO; bar < BUILD; bar++) {
    chords("pad", bar, 84);
    arp(bar, 62);
    put("sub", bar, 0, 15.5, chordAt(bar).root, 76);

    if (bar >= 4) {
        for (let step = 0; step < 16; step += 2) {
            put("hat", bar, step, 1, 42, step % 4 === 2 ? 84 : 50);
        }
    }
}

// Build: the tune, a kick on every beat, the roll and the risers. The last half bar is empty but for the dive.
for (let bar = BUILD; bar < DROP1; bar++) {
    chords("pad", bar, 90);
    arp(bar, 74);

    if (bar < DROP1 - 1) {
        for (const step of [0, 4, 8, 12]) {
            put("kick", bar, step, 3, 36, 106);
        }

        for (let step = 0; step < 16; step += 2) {
            put("hat", bar, step, 1, 42, step % 4 === 2 ? 96 : 56);
        }
    }
}
tune("lead", BUILD, 8, 90);
build(BUILD + 4, 4);
put("dive", DROP1 - 1, 8, 8, 60, 120);

function drop(start: number, order: RiffName[], second: boolean) {
    for (let bar = start; bar < start + 16; bar++) {
        const index = bar - start;
        const fill = index % 8 === 7;
        drums(bar, { fill, busy: second && index >= 8 });
        bass(bar, DROP_ROOTS[Math.floor(index / 2) % 4], fill ? "turn" : order[index % order.length]);

        if (second && index % 2 === 0) {
            for (const midi of chordAt(index).tones) {
                put("stab", bar, 0, 3, midi + 12, 108);
            }
        }
    }

    for (const bar of [start, start + 8]) {
        put("cymbal", bar, 0, 16, 49, 112);
        put("impact", bar, 0, 24, 36, bar === start ? 120 : 88);
    }

    put("boom", start, 0, 64, 60, 118);
    put("down", start, 0, 28, 60, 110);

    if (second) {
        tune("lead", start + 8, 8, 86);
    }
}

drop(DROP1, ["call", "answer", "call", "climb"], false);

// Breakdown: no drums. Pad, plucks and the tune, then a short build and a rewind.
for (let bar = BREAK; bar < DROP2; bar++) {
    chords("pad", bar, 90);
    arp(bar, 78);
    put("sub", bar, 0, 15.5, chordAt(bar).root, 82);
}
tune("lead", BREAK, 8, 92);
put("impact", BREAK, 0, 24, 36, 96);
put("cymbal", BREAK, 0, 16, 49, 90);
build(BUILD2, 4);
put("rewind", DROP2 - 1, 8, 8, 60, 118);

drop(DROP2, ["answer", "climb", "call", "answer"], true);

// Outro: pad, plucks and the tune once more, then the last chord.
for (let bar = OUTRO; bar < END - 2; bar++) {
    chords("pad", bar, 84);
    arp(bar, 66);
    put("sub", bar, 0, 15.5, chordAt(bar).root, 76);
}
tune("lead", OUTRO, 4, 84);
put("impact", OUTRO, 0, 24, 36, 104);
put("cymbal", OUTRO, 0, 16, 49, 100);

for (const midi of CHORDS[0].tones) {
    put("pad", END - 2, 0, 30, midi, 80);
}
put("sub", END - 2, 0, 24, 28, 90);
put("impact", END - 2, 0, 24, 36, 90);

// The recorded hits play the same notes as the synth drums they are layered with.
notes.kickHit = notes.kick;
notes.snareHit = notes.snare;
notes.clap = notes.snare;
notes.hatHit = notes.hat;

const synth = (patch: string): Source => ({ kind: "synth", patch });
const sample = (file: string, mode: "hit" | "pitched" = "hit"): Source => ({
    kind: "sample",
    file,
    mode,
    root: 60,
    slices: 16,
    speed: 1,
});
const pump = (depth: number, release = 170): Effects["duck"] => ({ by: ["kick", "snare"], depth, hold: 30, release });
const echo = (mix: number, feedback = 0.4): Effects["delay"] => ({
    time: STEP * 3,
    feedback,
    mix,
    pingPong: true,
    lowpass: 4600,
});

/** A value that rises through each build and falls back for the next one. */
function rises(from: number, to: number): [number, number][] {
    return [
        [t(BUILD + 4), from],
        [t(DROP1) - STEP * 8, to],
        [t(DROP1), from],
        [t(BUILD2), from],
        [t(DROP2) - STEP * 8, to],
    ];
}

function falls(from: number, to: number): [number, number][] {
    return [DROP1, DROP2].flatMap((bar): [number, number][] => [
        [t(bar), from],
        [t(bar) + STEP * 28, to],
    ]);
}

const hold = (points: [number, number][]): Lane["points"] => (points.length > 0 ? points : [[0, 1]]);

const setup: Record<PartName, PartSetup> = {
    kick: {
        source: synth("kick"),
        effects: {
            highpass: 28,
            eq: [
                { type: "peak", frequency: 58, gain: 3, q: 1 },
                { type: "peak", frequency: 320, gain: -3, q: 1.2 },
            ],
            drive: { amount: 4 },
            gain: -1,
        },
    },
    kickHit: { source: sample("sonic-pi/bd_tek.flac"), effects: { highpass: 30, drive: { amount: 5 }, gain: -3 } },
    snare: {
        source: synth("snare"),
        effects: {
            highpass: 120,
            eq: [
                { type: "peak", frequency: 190, gain: 4, q: 1.2 },
                { type: "highshelf", frequency: 6000, gain: 4 },
            ],
            compressor: { threshold: -12, ratio: 3, attack: 6, release: 90, makeup: 2 },
            reverb: 0.3,
            gain: -10,
        },
    },
    snareHit: {
        source: sample("sonic-pi/sn_dolf.flac"),
        effects: {
            highpass: 130,
            eq: [{ type: "peak", frequency: 200, gain: 3, q: 1.2 }],
            compressor: { threshold: -12, ratio: 3, attack: 6, release: 90, makeup: 2 },
            reverb: 0.3,
            gain: -5,
        },
    },
    clap: { source: sample("tr808/cp8/CP.WAV"), effects: { highpass: 500, width: 1.3, reverb: 0.4, gain: -4 } },
    hat: { source: synth("hat"), pan: 72, effects: { highpass: 6500, gain: -8 } },
    hatHit: { source: sample("sonic-pi/drum_cymbal_closed.flac"), pan: 56, effects: { highpass: 5000, gain: -12 } },
    openHat: { source: synth("openHat"), pan: 58, effects: { highpass: 5000, gain: -10 } },
    cymbal: {
        source: { kind: "soundfont", program: 0, percussion: true },
        effects: { highpass: 400, reverb: 0.3, gain: 0 },
    },
    roll: { source: synth("roll"), effects: { highpass: 150, reverb: 0.3, gain: -9 } },
    sub: {
        source: synth("sub"),
        effects: { lowpass: 140, duck: { by: ["kick"], depth: 0.9, hold: 35, release: 120 }, gain: -9.5 },
    },
    wobble: {
        source: synth("wobble"),
        effects: {
            highpass: 85,
            eq: [{ type: "peak", frequency: 1300, gain: 3, q: 0.9 }],
            drive: { amount: 10 },
            lowpass: 9000,
            width: 1.15,
            monoBelow: 200,
            duck: pump(0.6, 130),
            gain: -11,
        },
        lanes: [{ target: "lfoRate", points: hold(wobbleRate), hold: true }],
    },
    growl: {
        source: synth("growl"),
        effects: {
            highpass: 110,
            eq: [
                { type: "lowshelf", frequency: 320, gain: 4 },
                { type: "peak", frequency: 2200, gain: 3, q: 0.9 },
            ],
            drive: { amount: 12, shape: "fold", mix: 0.5 },
            compressor: { threshold: -16, ratio: 4, attack: 4, release: 80, makeup: 2 },
            lowpass: 10000,
            width: 1.25,
            monoBelow: 220,
            duck: pump(0.6, 130),
            gain: -7,
        },
        lanes: [
            { target: "vowel", points: hold(growlVowel) },
            { target: "lfoRate", points: [[0, BEAT_HZ * 4]] },
        ],
    },
    pad: {
        source: synth("pad"),
        effects: { highpass: 240, width: 1.25, duck: pump(0.7, 220), reverb: 0.5, gain: -15 },
        lanes: [
            {
                target: "lowpass",
                points: [
                    [0, 400],
                    [t(BUILD), 1400],
                    [t(DROP1) - 0.01, 5000],
                    [t(DROP1), 2200],
                    [t(BREAK), 6000],
                    [t(DROP2) - 0.01, 6000],
                    [t(DROP2), 2600],
                    [t(OUTRO), 7000],
                    [t(END), 500],
                ],
            },
        ],
    },
    stab: {
        source: synth("stab"),
        effects: {
            highpass: 300,
            eq: [{ type: "highshelf", frequency: 5000, gain: 4 }],
            delay: echo(0.25),
            width: 1.3,
            duck: pump(0.6),
            reverb: 0.4,
            gain: -17,
        },
    },
    pluck: {
        source: synth("pluck"),
        pan: 80,
        effects: { highpass: 300, delay: echo(0.32, 0.45), duck: pump(0.4), reverb: 0.4, gain: -10 },
    },
    lead: {
        source: synth("voice"),
        effects: {
            highpass: 260,
            eq: [{ type: "peak", frequency: 2500, gain: 2, q: 1 }],
            delay: echo(0.3, 0.45),
            duck: pump(0.4),
            reverb: 0.5,
            gain: -8,
        },
    },
    sweep: {
        source: synth("sweep"),
        effects: { highpass: 300, width: 1.3, reverb: 0.3, gain: -11 },
        lanes: [
            { target: "cutoff", points: rises(0, 5.5) },
            { target: "level", points: rises(-26, 0) },
        ],
    },
    siren: {
        source: synth("siren"),
        effects: { highpass: 250, reverb: 0.3, gain: -18 },
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
    impact: { source: synth("impact"), effects: { reverb: 0.5, gain: -6 } },
    boom: { source: sample("sonic-pi/misc_cineboom.flac"), effects: { highpass: 45, reverb: 0.3, gain: -10 } },
    dive: { source: sample("sonic-pi/bass_drop_c.flac", "pitched"), effects: { highpass: 30, gain: -6 } },
    rewind: {
        source: sample("sonic-pi/vinyl_rewind.flac", "pitched"),
        effects: { highpass: 200, reverb: 0.2, gain: -6 },
    },
};

/** An original dubstep track: half-time drums, a wobble bass whose speed changes note by note, and a growl. */
export function tremorScore(): Score {
    return scoreSchema.parse({
        key: "Tremor",
        title: "Tremor",
        bpm: BPM,
        seconds: t(END) + 4,
        end: t(END) + 2,
        parts: track.parts(setup),
        room: { size: 0.86, damp: 0.3, predelay: 22, highpass: 300, lowpass: 8500, level: -3 },
        master: { lufs: -8, peak: -1, limiter: true, clip: 4 },
    });
}
