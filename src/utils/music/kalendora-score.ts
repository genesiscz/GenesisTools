// Copied from /Users/Martin/Tresors/Projects/Kalendora/video/scripts/music.ts at 2026-11-12T06:17:16+01:00 at commit hash 481f90467dafdc609cfc834993855299b7410f94
const Length = 95;
export const SCORE_SECONDS = Length;
export const SCORE_END = 91.5;

type Hit = { midi: number; vel: number };
/** One note per step of a grid; `null` is a rest. */
type Steps = (Hit | null)[];

interface Sound {
    /** A waveform of the phase `p` (2πf·tl) and the note's own time `tl`; `f` is the frequency. */
    tone: (p: string, tl: string, f: string) => string;
    /** Attack time constant, seconds. */
    attack: number;
    /** Seconds the note holds at full level before it decays (a pad holds through its chord). */
    hold: number;
    /** Decay rate after the hold, 1/s. */
    decay: number;
}

interface Line {
    step: number;
    steps: Steps;
    /** Steps a note may ring before the next note of the same voice cuts it (it is faded out there, so no click). */
    ring: number;
    sound: Sound;
}

/** A pitched instrument: some lines summed in one aevalsrc, then filters and a stereo place. */
interface Tonal {
    kind: "tonal";
    lines: Line[];
    filters: string;
    gain: number;
    pan: [number, number];
    /** Milliseconds the right channel lags, for width. */
    width?: number;
}

/** A noise instrument: white noise (fixed seed) through `filters`, times the envelope of its lines (or `envelope`). */
interface Noise {
    kind: "noise";
    seed: number;
    lines: Line[];
    envelope?: string;
    filters: string;
    post?: string;
    gain: number;
    pan: [number, number];
}

type Instrument = Tonal | Noise;

interface Track {
    key: string;
    title: string;
    file: string;
    bpm: number;
    tonality: string;
    structure: string;
    instruments: () => Instrument[];
}

const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(6).replace(/0+$/, ""));

/** A grid of `count` empty steps. */
function grid(count: number): Steps {
    return Array.from({ length: count }, () => null);
}

/** Steps that cover the whole file at `step` seconds each. */
const stepsFor = (step: number) => Math.ceil(Length / step) + 1;

// ---------------------------------------------------------------------------------------------------------------------
// Sounds

/** A soft pad: two slightly detuned partial sets, so it slowly beats like a chorus. */
const pad = (attack: number, hold: number): Sound => ({
    attack,
    hold,
    decay: 1.4,
    tone: (p) => `(sin(${p})+0.8*sin(${p}*1.0035)+0.22*sin(2*${p})+0.08*sin(3*${p}*1.002))`,
});

/** A soft pluck: mostly the fundamental, a short bright edge. */
const pluck = (decay: number): Sound => ({
    attack: 0.003,
    hold: 0,
    decay,
    tone: (p, tl) => `(sin(${p})+0.35*sin(2*${p})*exp(-${tl}*6)+0.12*sin(3*${p})*exp(-${tl}*10))`,
});

/** A round bass: fundamental and a quiet octave, so small speakers hear it. */
const bass = (decay: number): Sound => ({
    attack: 0.006,
    hold: 0,
    decay,
    tone: (p, tl) => `(sin(${p})+0.45*sin(2*${p})*exp(-${tl}*3)+0.15*sin(3*${p})*exp(-${tl}*8))`,
});

/**
 * A soft kick: a sine that falls from about 105 Hz to the note's pitch, with a slow attack, so it is a short low thump
 * without a click. (The first version fell from 140 Hz with a 2 ms attack and rang twice as long: "too much kick".)
 */
const kick: Sound = {
    attack: 0.005,
    hold: 0,
    decay: 14,
    tone: (_p, tl, f) => `sin(2*PI*(${f}*${tl}+(105-${f})/30*(1-exp(-30*${tl}))))`,
};

/** An envelope only, for noise drums. */
const hit = (attack: number, decay: number): Sound => ({ attack, hold: 0, decay, tone: () => "1" });

// ---------------------------------------------------------------------------------------------------------------------
// Composition helpers

/** The chord index for a bar, with an optional ending chord from `endBar` on. */
function chordAt(bar: number, perChord: number, count: number, endBar?: number, endChord?: number): number {
    if (endBar !== undefined && endChord !== undefined && bar >= endBar) {
        return endChord;
    }
    return Math.floor(bar / perChord) % count;
}

/** 0 before `from`, 1 after `to`, a straight ramp between. */
function ramp(t: number, from: number, to: number): number {
    return Math.min(1, Math.max(0, (t - from) / (to - from)));
}

// ---------------------------------------------------------------------------------------------------------------------
// Pulse "Tep": 100 BPM, A minor, Am – F – C – G, one bar each; the energy rises from 78 s and resolves on C.

/** How much of the drum kit plays: the soft kick, hats and claps, or none of them (pad, bass, arpeggio and riser only). */
type Drums = "soft" | "none";

function pulse(drums: Drums): Instrument[] {
    const beat = 0.6;
    const bar = beat * 4;
    const eighth = beat / 2;
    const sixteenth = beat / 4;
    const endBar = 36; // 86.4 s: the build stops and the music settles on C major
    const BuildFrom = 78;
    const BuildTo = endBar * bar;
    const voicings = [
        [57, 60, 64],
        [57, 60, 65],
        [55, 60, 64],
        [55, 59, 62],
    ];
    const arpTones = [
        [69, 72, 76, 81],
        [69, 72, 77, 81],
        [67, 72, 76, 79],
        [67, 71, 74, 79],
    ];
    const roots = [45, 41, 48, 43];
    const C = 2;
    const chordOfBar = (b: number) => chordAt(b, 1, 4, endBar, C);
    const build = (t: number) => (t < BuildTo ? ramp(t, BuildFrom, BuildTo) : 0);

    const padLines: Line[] = [0, 1, 2].map((tone) => {
        const steps = grid(stepsFor(bar));
        steps.forEach((_, b) => {
            steps[b] = { midi: voicings[chordOfBar(b)][tone], vel: b >= endBar ? 0.9 : 0.6 };
        });
        return { step: bar, steps, ring: 2, sound: pad(0.35, bar) };
    });

    // Bass: plucked eighths, the root with an octave jump, from bar 2; holds the C at the end.
    const bassPattern = [0, 0, 12, 0, 0, 12, 0, 7];
    const bassAccent = [1, 0.6, 0.8, 0.6, 0.9, 0.6, 0.8, 0.65];
    const bassSteps = grid(stepsFor(eighth));
    bassSteps.forEach((_, i) => {
        const t = i * eighth;
        const b = Math.floor(t / bar);
        const slot = i % 8;
        if (b < 2) {
            return;
        }
        if (b >= endBar) {
            if (b === endBar && slot === 0) {
                bassSteps[i] = { midi: roots[C], vel: 1 };
            }
            return;
        }
        bassSteps[i] = { midi: roots[chordOfBar(b)] + bassPattern[slot], vel: bassAccent[slot] };
    });

    // Arpeggio: sixteenths from bar 4, louder through the build; quarter notes falling down C major at the end.
    const arpPattern = [0, 1, 2, 3, 2, 1, 0, 1, 0, 2, 3, 2, 1, 2, 3, 1];
    const arp = grid(stepsFor(sixteenth));
    arp.forEach((_, i) => {
        const t = i * sixteenth;
        const b = Math.floor(t / bar);
        const slot = i % 16;
        if (b < 4) {
            return;
        }
        if (b >= endBar) {
            const fall = [84, 79, 76, 72, 67];
            const q = Math.floor((t - endBar * bar) / beat);
            if (slot % 4 === 0 && q < fall.length) {
                arp[i] = { midi: fall[q], vel: 0.75 };
            }
            return;
        }
        const base = b < 8 ? 0.35 : 0.5;
        const level = base + 0.5 * build(t);
        arp[i] = { midi: arpTones[chordOfBar(b)][arpPattern[slot]], vel: level * (slot % 4 === 0 ? 1 : 0.72) };
    });

    // Kick: four on the floor from bar 2, stops at the resolution.
    const kicks = grid(stepsFor(beat));
    kicks.forEach((_, i) => {
        const b = Math.floor((i * beat) / bar);
        if (b < 2 || b >= endBar) {
            return;
        }
        kicks[i] = { midi: 33, vel: b < 4 ? 0.6 : 0.8 + 0.2 * build(i * beat) };
    });

    // Hats: offbeat eighths from bar 4, sixteenths in the build.
    const hats = grid(stepsFor(sixteenth));
    hats.forEach((_, i) => {
        const t = i * sixteenth;
        const b = Math.floor(t / bar);
        if (b < 4 || b >= endBar) {
            return;
        }
        const slot = i % 4;
        if (slot === 2) {
            hats[i] = { midi: 60, vel: 0.8 };
        } else if (build(t) > 0 && slot !== 0) {
            hats[i] = { midi: 60, vel: 0.35 * build(t) };
        }
    });

    // Clap: beats 2 and 4 from bar 8.
    const claps = grid(stepsFor(beat));
    claps.forEach((_, i) => {
        const b = Math.floor((i * beat) / bar);
        if (b < 8 || b >= endBar || i % 2 === 0) {
            return;
        }
        claps[i] = { midi: 60, vel: 0.55 + 0.45 * build(i * beat) };
    });

    const riser = `if(between(t,${BuildFrom},${BuildTo}),pow((t-${BuildFrom})/${num(BuildTo - BuildFrom)},2)*min(1,(${num(BuildTo)}-t)/0.05),0)`;
    const arpTone: Sound = {
        ...pluck(7),
        tone: (p, tl) => {
            const bright = `(0.5+0.5*if(lt(t,${num(BuildTo)}),clip((t-${BuildFrom})/${num(BuildTo - BuildFrom)},0,1),0))`;
            return `(sin(${p})+${bright}*(0.5*sin(2*${p})*exp(-${tl}*8)+0.3*sin(3*${p})*exp(-${tl}*14)+0.15*sin(5*${p})*exp(-${tl}*20)))`;
        },
    };

    // The balance: the arpeggio and the pad carry the track; the bass and the kick stay under them.
    const tonal: Instrument[] = [
        {
            kind: "tonal",
            lines: padLines,
            filters: "lowpass=f=2200,aecho=0.8:0.6:75|150:0.25|0.15",
            gain: 0.15,
            pan: [0.85, 0.85],
            width: 12,
        },
        {
            kind: "tonal",
            lines: [{ step: eighth, steps: bassSteps, ring: 2, sound: bass(4.5) }],
            filters: "highpass=f=45,lowpass=f=700",
            gain: 0.19,
            pan: [0.85, 0.85],
        },
        {
            kind: "tonal",
            lines: [{ step: sixteenth, steps: arp, ring: 4, sound: arpTone }],
            filters: "highpass=f=250,aecho=0.8:0.5:300|450:0.3|0.18",
            gain: 0.17,
            pan: [0.6, 0.9],
        },
        {
            kind: "noise",
            seed: 37,
            lines: [],
            envelope: riser,
            filters: "highpass=f=1500,lowpass=f=9000",
            post: "aecho=0.8:0.6:120|240:0.3|0.2",
            gain: 0.06,
            pan: [0.8, 0.8],
        },
    ];
    if (drums === "none") {
        return tonal;
    }
    return [
        ...tonal,
        {
            kind: "tonal",
            lines: [{ step: beat, steps: kicks, ring: 1, sound: kick }],
            filters: "highpass=f=40,lowpass=f=220",
            gain: 0.13,
            pan: [0.85, 0.85],
        },
        {
            kind: "noise",
            seed: 11,
            lines: [{ step: sixteenth, steps: hats, ring: 1, sound: hit(0.001, 38) }],
            filters: "highpass=f=7000,lowpass=f=13000",
            gain: 0.14,
            pan: [0.75, 0.9],
        },
        {
            kind: "noise",
            seed: 23,
            lines: [{ step: beat, steps: claps, ring: 1, sound: hit(0.002, 16) }],
            filters: "bandpass=f=1600:width_type=o:w=1.4",
            post: "aecho=0.8:0.5:60|110:0.3|0.2",
            gain: 0.13,
            pan: [0.85, 0.75],
        },
    ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Shelved tracks. Martin heard them on 2026-11-10 and did not want them ("Calm" reads as lift music, "Piano" is harsh).
// The scores stay so the work is not lost; `bun scripts/music.ts Calm` renders one into out/music-shelved/ (not
// committed, not in tracks.json).

/** A piano-like note: harmonics that fade faster the higher they are, slightly stretched like a real string. */
const piano = (decay: number, bright = 1): Sound => ({
    attack: 0.0025,
    hold: 0,
    decay,
    tone: (p, tl) =>
        `(sin(${p})+${num(0.42 * bright)}*sin(2.0008*${p})*exp(-${tl}*1.6)+${num(0.2 * bright)}*sin(3.0024*${p})*exp(-${tl}*2.8)+${num(0.09 * bright)}*sin(4.005*${p})*exp(-${tl}*4))`,
});

function calm(): Instrument[] {
    const beat = 60 / 70;
    const bar = beat * 4;
    const eighth = beat / 2;
    const chordBars = 2;
    const endBar = 24; // 82.3 s: from here the progression stays on D, the home chord
    const voicings = [
        [50, 57, 64, 66],
        [47, 57, 62, 66],
        [43, 54, 59, 62],
        [45, 57, 61, 64],
    ];
    const arpTones = [
        [62, 64, 66, 69, 74],
        [59, 62, 66, 69, 71],
        [55, 59, 62, 66, 67],
        [57, 61, 64, 69, 71],
    ];
    const roots = [38, 35, 43, 45];
    const chordOfBar = (b: number) => chordAt(b, chordBars, 4, endBar, 0);

    // Pad: one step per chord (two bars), the four tones as four lines; each ring two chords so the change cross-fades.
    const padStep = bar * chordBars;
    const padLines: Line[] = [0, 1, 2, 3].map((tone) => {
        const steps = grid(stepsFor(padStep));
        steps.forEach((_, i) => {
            steps[i] = { midi: voicings[chordOfBar(i * chordBars)][tone], vel: tone === 0 ? 0.8 : 0.6 };
        });
        return { step: padStep, steps, ring: 2, sound: pad(0.9, padStep) };
    });

    // Plucks: eighths over the chord, in from bar 2, sparse in the last bars.
    const pattern = [0, 2, 3, 4, 3, 2, 1, 2];
    const accents = [1, 0.55, 0.7, 0.55, 0.85, 0.55, 0.65, 0.5];
    const plucks = grid(stepsFor(eighth));
    plucks.forEach((_, i) => {
        const t = i * eighth;
        const b = Math.floor(t / bar);
        const slot = i % 8;
        if (b < 1) {
            return;
        }
        if (t >= 86 && slot % 4 !== 0) {
            return;
        }
        const level = 0.45 + 0.55 * ramp(t, bar, bar * 4);
        plucks[i] = { midi: arpTones[chordOfBar(b)][pattern[slot]], vel: level * accents[slot] };
    });

    // Bass: half notes on the root from bar 4.
    const half = beat * 2;
    const bassSteps = grid(stepsFor(half));
    bassSteps.forEach((_, i) => {
        const t = i * half;
        const b = Math.floor(t / bar);
        if (b < 4) {
            return;
        }
        bassSteps[i] = { midi: roots[chordOfBar(b)], vel: i % 2 === 0 ? 1 : 0.6 };
    });

    // Bell melody: one note per half bar, bars 8 to 23, the same eight-bar phrase twice.
    const phrase = [74, 0, 73, 69, 71, 0, 69, 66, 67, 71, 74, 0, 73, 0, 76, 0];
    const melody = grid(stepsFor(half));
    melody.forEach((_, i) => {
        const b = Math.floor((i * half) / bar);
        if (b < 8 || b >= 24) {
            return;
        }
        const midi = phrase[(i - 16) % 16];
        if (midi) {
            melody[i] = { midi, vel: b >= 16 ? 0.9 : 0.7 };
        }
    });

    return [
        {
            kind: "tonal",
            lines: padLines,
            filters: "lowpass=f=1600,aecho=0.8:0.7:90|170:0.3|0.2",
            gain: 0.16,
            pan: [0.85, 0.85],
            width: 14,
        },
        {
            kind: "tonal",
            lines: [{ step: eighth, steps: plucks, ring: 4, sound: piano(2.2, 0.6) }],
            filters: "lowpass=f=3200,aecho=0.8:0.6:230|460:0.32|0.16",
            gain: 0.24,
            pan: [0.85, 0.6],
        },
        {
            kind: "tonal",
            lines: [{ step: half, steps: bassSteps, ring: 2, sound: bass(1.1) }],
            filters: "lowpass=f=600",
            gain: 0.3,
            pan: [0.8, 0.8],
        },
        {
            kind: "tonal",
            lines: [{ step: half, steps: melody, ring: 3, sound: pluck(1.3) }],
            filters: "lowpass=f=4500,aecho=0.8:0.6:340|680:0.35|0.2",
            gain: 0.13,
            pan: [0.55, 0.85],
        },
    ];
}

function pianoTrack(): Instrument[] {
    const beat = 60 / 84;
    const bar = beat * 4;
    const eighth = beat / 2;
    const endBar = 31; // 88.6 s: C then home to G (a plagal close)
    const _G = 0;
    // Chord: [bass root, left-hand fifth, right-hand tones (3rd, 5th, octave)].
    const chords = [
        { root: 43, fifth: 50, tones: [59, 62, 67] }, // G
        { root: 42, fifth: 50, tones: [57, 62, 66] }, // D/F#
        { root: 40, fifth: 47, tones: [55, 59, 64] }, // Em
        { root: 36, fifth: 43, tones: [55, 60, 64] }, // C
        { root: 43, fifth: 50, tones: [59, 62, 67] }, // G
        { root: 38, fifth: 45, tones: [57, 62, 66] }, // D
        { root: 36, fifth: 43, tones: [55, 60, 62] }, // Csus2
        { root: 38, fifth: 45, tones: [54, 57, 62] }, // D
    ];
    const finalChord = { root: 31, fifth: 43, tones: [59, 62, 67] };
    const chordOf = (b: number) => (b >= endBar ? finalChord : chords[chordAt(b, 1, 8, undefined, undefined)]);

    // Left hand: the root on beat 1, the fifth on beat 3; one long low G at the end.
    const half = beat * 2;
    const left = grid(stepsFor(half));
    left.forEach((_, i) => {
        const b = Math.floor((i * half) / bar);
        const c = chordOf(b);
        if (b >= endBar) {
            if (b === endBar && i % 2 === 0) {
                left[i] = { midi: c.root + 12, vel: 0.95 };
            }
            return;
        }
        left[i] = { midi: i % 2 === 0 ? c.root : c.fifth, vel: i % 2 === 0 ? 0.9 : 0.6 };
    });

    // Right hand: a broken chord in eighths from bar 2; bars 0 and 1 hold a chord on beat 1; the end holds G major.
    const shape = [0, 1, 2, 1, 0, 1, 2, 1];
    const accent = [0.85, 0.5, 0.65, 0.5, 0.75, 0.5, 0.6, 0.45];
    const right = grid(stepsFor(eighth));
    const chordHits: Line[] = [0, 1, 2].map((tone) => {
        const steps = grid(stepsFor(bar));
        steps.forEach((_, b) => {
            if (b < 2 || b === endBar) {
                steps[b] = { midi: chordOf(b).tones[tone], vel: 0.6 };
            }
        });
        return { step: bar, steps, ring: 1, sound: piano(0.55) };
    });
    right.forEach((_, i) => {
        const b = Math.floor((i * eighth) / bar);
        if (b < 2 || b >= endBar) {
            return;
        }
        const slot = i % 8;
        right[i] = { midi: chordOf(b).tones[shape[slot]], vel: accent[slot] * (b < 4 ? 0.75 : 1) };
    });

    // Melody: quarter notes, bars 8 to 30, an eight-bar phrase, played an octave higher the second time.
    const phrase = [
        [74, 0, 71, 74],
        [76, 0, 74, 0],
        [71, 0, 67, 71],
        [72, 0, 0, 0],
        [74, 0, 79, 78],
        [76, 0, 74, 0],
        [76, 74, 72, 0],
        [74, 0, 0, 0],
    ];
    const melody = grid(stepsFor(beat));
    melody.forEach((_, i) => {
        const b = Math.floor((i * beat) / bar);
        if (b < 8 || b >= 30) {
            return;
        }
        const midi = phrase[(b - 8) % 8][i % 4];
        if (!midi) {
            return;
        }
        const lift = b >= 16 && b < 24 ? 12 : 0;
        melody[i] = { midi: midi + lift, vel: i % 4 === 0 ? 0.95 : 0.8 };
    });
    // The last melody note: a high G on the final chord.
    const lastBeat = Math.round((endBar * bar) / beat);
    melody[lastBeat] = { midi: 79, vel: 0.85 };

    // Shaker: eighths from bar 4 with a lighter offbeat sixteenth, stops at the end.
    const sixteenth = beat / 4;
    const shaker = grid(stepsFor(sixteenth));
    shaker.forEach((_, i) => {
        const b = Math.floor((i * sixteenth) / bar);
        if (b < 4 || b >= endBar) {
            return;
        }
        const slot = i % 4;
        if (slot === 0) {
            shaker[i] = { midi: 60, vel: 0.55 };
        } else if (slot === 2) {
            shaker[i] = { midi: 60, vel: 0.9 };
        } else if (slot === 3) {
            shaker[i] = { midi: 60, vel: 0.3 };
        }
    });

    return [
        {
            kind: "tonal",
            lines: [{ step: half, steps: left, ring: 2, sound: piano(0.9) }],
            filters: "lowpass=f=1800,aecho=0.8:0.55:140|260:0.25|0.15",
            gain: 0.3,
            pan: [0.9, 0.75],
        },
        {
            kind: "tonal",
            lines: [{ step: eighth, steps: right, ring: 4, sound: piano(1.6) }, ...chordHits],
            filters: "lowpass=f=4000,aecho=0.8:0.55:140|260:0.25|0.15",
            gain: 0.2,
            pan: [0.7, 0.9],
            width: 8,
        },
        {
            kind: "tonal",
            lines: [{ step: beat, steps: melody, ring: 3, sound: piano(1.1, 1.2) }],
            filters: "lowpass=f=6000,aecho=0.8:0.6:200|400:0.3|0.15",
            gain: 0.22,
            pan: [0.85, 0.85],
        },
        {
            kind: "noise",
            seed: 5,
            lines: [{ step: sixteenth, steps: shaker, ring: 1, sound: hit(0.006, 30) }],
            filters: "highpass=f=6000,lowpass=f=11000",
            gain: 0.07,
            pan: [0.9, 0.6],
        },
    ];
}

// ---------------------------------------------------------------------------------------------------------------------
// The table

export const MusicTracks = {
    Pulse: {
        key: "Pulse",
        title: "Tep",
        file: "pulse.m4a",
        bpm: 100,
        tonality: "A minor, ends on C major",
        structure:
            "Pad, then a soft kick and bass from 4.8 s, arpeggio and hats from 9.6 s, claps from 19 s; a build 78 to 86 s; settles on C at 86.4 s.",
        instruments: () => pulse("soft"),
    },
    PulseLight: {
        key: "PulseLight",
        title: "Tep bez bicích",
        file: "pulse-light.m4a",
        bpm: 100,
        tonality: "A minor, ends on C major",
        structure:
            "The same track without kick, hats and claps: pad, bass from 4.8 s, arpeggio from 9.6 s; a build 78 to 86 s; settles on C at 86.4 s.",
        instruments: () => pulse("none"),
    },
} satisfies Record<string, Track>;

export const ShelvedTracks = {
    Calm: {
        key: "Calm",
        title: "Klidná",
        file: "calm.m4a",
        bpm: 70,
        tonality: "D major",
        structure:
            "Pad alone, plucked eighths from 3.4 s, bass from 13.7 s, a bell melody 27 to 82 s, home on D from 82 s.",
        instruments: calm,
    },
    Piano: {
        key: "Piano",
        title: "Klavír",
        file: "piano.m4a",
        bpm: 84,
        tonality: "G major",
        structure:
            "Held chords, broken chords from 5.7 s, shaker from 11.4 s, a melody 23 to 86 s (an octave higher 46 to 69 s), C to G at the end.",
        instruments: pianoTrack,
    },
} satisfies Record<string, Track>;
