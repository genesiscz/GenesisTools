import type { Envelope, Patch } from "./types";

/** A struck sound: no sustain, and a release as long as the decay, so a short note still rings out. */
const hit = (decay: number): Envelope => ({ attack: 0, decay, sustain: 0, release: decay });
const GATE = hit(0.01);

const kick: Patch = {
    oscillators: [
        { wave: "sine", fixed: 50, pitchEnvelope: { semitones: 29, decay: 0.055 }, envelope: hit(0.27) },
        { wave: "sine", fixed: 100, pitchEnvelope: { semitones: 24, decay: 0.03 }, envelope: hit(0.07), level: 0.35 },
        { wave: "noise", filter: { type: "highpass", cutoff: 2500 }, envelope: hit(0.012), level: 0.3 },
    ],
    envelope: GATE,
    drive: 5,
};

const snare: Patch = {
    oscillators: [
        { wave: "sine", fixed: 190, pitchEnvelope: { semitones: 9, decay: 0.035 }, envelope: hit(0.17) },
        { wave: "triangle", fixed: 330, pitchEnvelope: { semitones: 5, decay: 0.02 }, envelope: hit(0.08), level: 0.4 },
        {
            wave: "noise",
            width: 0.3,
            filter: { type: "bandpass", cutoff: 3600, q: 0.6 },
            envelope: hit(0.2),
            level: 1.1,
        },
        { wave: "noise", width: 0.5, filter: { type: "highpass", cutoff: 7500 }, envelope: hit(0.12), level: 0.45 },
        { wave: "noise", filter: { type: "highpass", cutoff: 1200 }, envelope: hit(0.008), level: 0.7 },
    ],
    envelope: GATE,
    drive: 4,
};

/** A snare whose body follows the note, for a roll that rises in pitch. */
const roll: Patch = {
    oscillators: [
        { wave: "sine", pitchEnvelope: { semitones: 7, decay: 0.03 }, envelope: hit(0.09) },
        { wave: "noise", width: 0.3, filter: { type: "bandpass", cutoff: 4200, q: 0.7 }, envelope: hit(0.1) },
    ],
    envelope: GATE,
    drive: 3,
};

const metal = (decay: number): Patch => ({
    oscillators: [
        { wave: "noise", width: 0.2, filter: { type: "highpass", cutoff: 8000, q: 1.2 }, envelope: hit(decay) },
        { wave: "sine", fixed: 5400, fm: { ratio: 1.483, index: 5 }, envelope: hit(decay * 0.7), level: 0.3 },
    ],
    envelope: GATE,
});

const hat = metal(0.05);
const openHat = metal(0.32);

const sub: Patch = {
    oscillators: [{ wave: "sine" }, { wave: "sine", semitones: 12, level: 0.12 }],
    envelope: { attack: 0.004, decay: 0.2, sustain: 0.85, release: 0.07 },
    mono: true,
    glide: 0.035,
    drive: 3,
};

const reese: Patch = {
    oscillators: [
        { wave: "saw", unison: 3, detune: 52, width: 0.8 },
        { wave: "saw", semitones: -12, unison: 2, detune: 18, width: 0.3, level: 0.6 },
        { wave: "square", pulseWidth: 0.35, level: 0.3 },
    ],
    envelope: { attack: 0.006, decay: 0.3, sustain: 0.85, release: 0.09 },
    filter: {
        type: "lowpass",
        cutoff: 420,
        q: 1.6,
        envelope: { attack: 0.005, decay: 0.35, sustain: 0.25, release: 0.1 },
        envelopeOctaves: 1.6,
        velocityOctaves: 1.4,
    },
    lfos: [
        { target: "cutoff", rate: 0.31, depth: 0.9 },
        { target: "cutoff", rate: 5.8, depth: 0.22 },
    ],
    mono: true,
    glide: 0.05,
    drive: 14,
};

const stab: Patch = {
    oscillators: [
        { wave: "saw", unison: 7, detune: 44, width: 1 },
        { wave: "saw", semitones: 12, unison: 5, detune: 56, width: 1, level: 0.45 },
    ],
    envelope: { attack: 0.004, decay: 0.25, sustain: 0.7, release: 0.2 },
    filter: {
        type: "lowpass",
        cutoff: 3600,
        q: 0.8,
        envelope: { attack: 0.002, decay: 0.22, sustain: 0.3, release: 0.2 },
        envelopeOctaves: 1.5,
        keyTrack: 0.3,
    },
};

const pad: Patch = {
    oscillators: [
        { wave: "saw", unison: 5, detune: 28, width: 1 },
        { wave: "triangle", semitones: -12, level: 0.5 },
    ],
    envelope: { attack: 0.35, decay: 0.6, sustain: 0.85, release: 0.9 },
    filter: { type: "lowpass", cutoff: 1500, q: 0.6 },
    lfos: [{ target: "cutoff", rate: 0.13, depth: 0.45 }],
};

/** A formant lead: a saw through vowel filters, with a slide between notes. It stands in for a vocal chop. */
const voice: Patch = {
    oscillators: [
        { wave: "saw", unison: 3, detune: 16, width: 0.5 },
        { wave: "square", pulseWidth: 0.3, level: 0.5 },
    ],
    envelope: { attack: 0.02, decay: 0.25, sustain: 0.8, release: 0.3 },
    filter: { type: "vowel", cutoff: 1000, q: 7, vowel: 0.2 },
    lfos: [
        { target: "vowel", rate: 0.45, depth: 0.5 },
        { target: "pitch", rate: 5.4, depth: 0.14 },
    ],
    mono: true,
    glide: 0.07,
};

const pluck: Patch = {
    oscillators: [{ wave: "saw" }, { wave: "square", semitones: 12, pulseWidth: 0.4, level: 0.3 }],
    envelope: { attack: 0.002, decay: 0.2, sustain: 0, release: 0.15 },
    filter: {
        type: "lowpass",
        cutoff: 500,
        q: 2.2,
        envelope: { attack: 0.001, decay: 0.13, sustain: 0, release: 0.1 },
        envelopeOctaves: 3.2,
    },
};

/** Noise for a sweep. A cutoff lane on the part moves it. */
const sweep: Patch = {
    oscillators: [{ wave: "noise", width: 1 }],
    envelope: { attack: 0.3, decay: 0.1, sustain: 1, release: 0.08 },
    filter: { type: "bandpass", cutoff: 300, q: 1.4 },
};

/** A stack of saws for a pitch rise. A pitch lane on the part moves it. */
const siren: Patch = {
    oscillators: [{ wave: "saw", unison: 5, detune: 70, width: 1 }],
    envelope: { attack: 0.4, decay: 0.1, sustain: 1, release: 0.05 },
    filter: { type: "lowpass", cutoff: 1800, q: 1.2 },
};

const impact: Patch = {
    oscillators: [
        { wave: "noise", width: 1, filter: { type: "lowpass", cutoff: 2600 }, envelope: hit(2.6) },
        { wave: "sine", fixed: 42, pitchEnvelope: { semitones: 14, decay: 0.6 }, envelope: hit(1.6), level: 1.2 },
    ],
    envelope: GATE,
};

/**
 * A wobble bass: the low-pass opens and closes once in each cycle, from the start of every note. The rate is
 * 1 Hz, so an `lfoRate` lane on the part gives the speed in Hz, note by note.
 */
const wobble: Patch = {
    oscillators: [
        { wave: "saw", unison: 3, detune: 26, width: 0.6 },
        { wave: "square", semitones: -12, pulseWidth: 0.5, level: 0.7 },
        { wave: "saw", semitones: 12, unison: 2, detune: 14, width: 0.4, level: 0.3 },
    ],
    envelope: { attack: 0.004, decay: 0.2, sustain: 0.95, release: 0.05 },
    filter: { type: "lowpass", cutoff: 460, q: 3.4 },
    lfos: [{ target: "cutoff", rate: 1, depth: 2.7, shape: "sine", retrigger: true }],
    mono: true,
    glide: 0.02,
    drive: 16,
};

/** A growl bass: FM sines and saws through the vowel filter. A `vowel` lane on the part makes it talk. */
const growl: Patch = {
    oscillators: [
        { wave: "sine", fm: { ratio: 2, index: 7 } },
        { wave: "sine", semitones: 12, fm: { ratio: 1.5, index: 5 }, level: 0.5 },
        { wave: "saw", unison: 3, detune: 34, width: 0.7, level: 0.55 },
    ],
    envelope: { attack: 0.003, decay: 0.2, sustain: 0.9, release: 0.05 },
    filter: { type: "vowel", cutoff: 1000, q: 5, vowel: 0 },
    lfos: [{ target: "fm", rate: 1, depth: 0.5, shape: "saw", retrigger: true }],
    mono: true,
    glide: 0.03,
    drive: 18,
};

/** Wide detuned saws for big chords. A deep duck on the part gives the pump of future bass. */
const supersaw: Patch = {
    oscillators: [
        { wave: "saw", unison: 7, detune: 46, width: 1 },
        { wave: "saw", semitones: 12, unison: 5, detune: 52, width: 1, level: 0.5 },
        { wave: "saw", semitones: -12, unison: 2, detune: 18, width: 0.4, level: 0.4 },
    ],
    envelope: { attack: 0.012, decay: 0.3, sustain: 0.85, release: 0.22 },
    filter: {
        type: "lowpass",
        cutoff: 5200,
        q: 0.7,
        envelope: { attack: 0.005, decay: 0.35, sustain: 0.5, release: 0.2 },
        envelopeOctaves: 1.2,
        keyTrack: 0.3,
    },
};

/**
 * An 808 bass: a sine that drops into its note and rings long. The drive adds harmonics that a small speaker can
 * play. Notes that touch slide into each other.
 */
const bass808: Patch = {
    oscillators: [
        { wave: "sine", pitchEnvelope: { semitones: 14, decay: 0.035 } },
        { wave: "sine", semitones: 12, level: 0.4 },
        { wave: "noise", filter: { type: "highpass", cutoff: 3000 }, envelope: hit(0.01), level: 0.15 },
    ],
    envelope: { attack: 0.002, decay: 1.2, sustain: 0.5, release: 0.12 },
    mono: true,
    glide: 0.07,
    drive: 14,
};

/** Ready sounds for `{ kind: "synth", patch: "<name>" }`. A score may also carry a whole patch. */
export const SYNTH_PRESETS: Record<string, Patch> = {
    kick,
    snare,
    roll,
    hat,
    openHat,
    sub,
    reese,
    wobble,
    growl,
    bass808,
    supersaw,
    stab,
    pad,
    voice,
    pluck,
    sweep,
    siren,
    impact,
};
