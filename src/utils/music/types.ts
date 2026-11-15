import { z } from "zod";

export const noteSchema = z.object({
    at: z.number().finite().min(0),
    duration: z.number().finite().positive(),
    midi: z.number().int().min(0).max(127),
    velocity: z.number().int().min(1).max(127),
});

const seconds = z.number().finite().min(0).max(60);
const hertz = z.number().finite().min(10).max(22000);

export const envelopeSchema = z.object({
    attack: seconds,
    decay: seconds,
    sustain: z.number().min(0).max(1),
    release: seconds,
});

const filterType = z.enum(["lowpass", "highpass", "bandpass", "notch"]);

export const oscillatorSchema = z.object({
    wave: z.enum(["sine", "triangle", "saw", "square", "noise"]),
    /** Linear level, 1 by default. */
    level: z.number().min(0).max(8).optional(),
    semitones: z.number().min(-48).max(48).optional(),
    /** A fixed frequency in Hz. The note's pitch is ignored (drums). */
    fixed: hertz.optional(),
    unison: z.number().int().min(1).max(16).optional(),
    /** Total detune spread of the unison voices, in cents. */
    detune: z.number().min(0).max(200).optional(),
    /** Stereo spread of the unison voices, 0 to 1. */
    width: z.number().min(0).max(1).optional(),
    pulseWidth: z.number().min(0.05).max(0.95).optional(),
    /** A pitch drop: starts `semitones` above the pitch and falls back in `decay` seconds. */
    pitchEnvelope: z
        .object({ semitones: z.number().min(-60).max(60), decay: z.number().positive().max(10) })
        .optional(),
    /** Phase modulation of a sine by a sine at `ratio` times its frequency. `decay` lets the index fall. */
    fm: z
        .object({
            ratio: z.number().positive().max(32),
            index: z.number().min(0).max(40),
            decay: z.number().positive().max(10).optional(),
        })
        .optional(),
    /** Its own amplitude envelope. Without one the oscillator follows the patch envelope. */
    envelope: envelopeSchema.optional(),
    filter: z.object({ type: filterType, cutoff: hertz, q: z.number().min(0.3).max(30).optional() }).optional(),
});

export const patchSchema = z.object({
    oscillators: z.array(oscillatorSchema).min(1).max(8),
    envelope: envelopeSchema,
    filter: z
        .object({
            type: z.union([filterType, z.literal("vowel")]),
            /** Hz. Type "vowel" ignores it; cutoff modulation moves the formants instead. */
            cutoff: hertz,
            q: z.number().min(0.3).max(30).optional(),
            envelope: envelopeSchema.optional(),
            /** Octaves the envelope adds at its peak. */
            envelopeOctaves: z.number().min(-10).max(10).optional(),
            /** Octaves a full-velocity note adds. */
            velocityOctaves: z.number().min(-10).max(10).optional(),
            /** 0 to 1: how far the cutoff follows the note's pitch (around middle C). */
            keyTrack: z.number().min(0).max(1).optional(),
            /** Vowel position for type "vowel": 0 a, 1 e, 2 i, 3 o, 4 u. */
            vowel: z.number().min(0).max(4).optional(),
        })
        .optional(),
    lfos: z
        .array(
            z.object({
                target: z.enum(["cutoff", "pitch", "level", "vowel", "fm"]),
                rate: z.number().positive().max(200),
                /** cutoff: octaves. pitch: semitones. level: 0 to 1. vowel: positions. fm: fraction of the index. */
                depth: z.number().min(-48).max(48),
                shape: z.enum(["sine", "triangle", "saw", "square"]).optional(),
                /** Start the wave again at each new note. Otherwise it runs on score time. */
                retrigger: z.boolean().optional(),
            })
        )
        .max(4)
        .optional(),
    /** One voice for the whole part. Notes that touch do not start the envelope again. */
    mono: z.boolean().optional(),
    /** Seconds a mono voice takes to slide to the next pitch. */
    glide: z.number().min(0).max(5).optional(),
    /** Saturation before the filter, in dB of input gain. */
    drive: z.number().min(0).max(48).optional(),
    /** Output level in dB. */
    level: z.number().min(-60).max(24).optional(),
});

const eqBandSchema = z.object({
    type: z.enum(["peak", "lowshelf", "highshelf"]),
    frequency: hertz,
    gain: z.number().min(-24).max(24),
    q: z.number().min(0.1).max(20).optional(),
});

/** The effect chain of one part, applied in this order. Times are in milliseconds, except the delay time. */
export const effectsSchema = z.object({
    highpass: hertz.optional(),
    lowpass: hertz.optional(),
    eq: z.array(eqBandSchema).max(8).optional(),
    /** Saturation. `amount` is dB of input gain; the level after it matches the level before. */
    drive: z
        .object({
            amount: z.number().min(0).max(48),
            shape: z.enum(["tanh", "hard", "fold"]).optional(),
            mix: z.number().min(0).max(1).optional(),
        })
        .optional(),
    crush: z
        .object({ bits: z.number().min(2).max(16).optional(), hold: z.number().int().min(1).max(64).optional() })
        .optional(),
    compressor: z
        .object({
            threshold: z.number().min(-60).max(0),
            ratio: z.number().min(1).max(40),
            attack: z.number().positive().max(500),
            release: z.number().positive().max(5000),
            makeup: z.number().min(-24).max(24).optional(),
        })
        .optional(),
    delay: z
        .object({
            time: z.number().positive().max(4),
            feedback: z.number().min(0).max(0.95),
            mix: z.number().min(0).max(1),
            pingPong: z.boolean().optional(),
            lowpass: hertz.optional(),
        })
        .optional(),
    /** Side level: 0 is mono, 1 leaves the image, more is wider. */
    width: z.number().min(0).max(3).optional(),
    /** Keep everything below this frequency in the centre. */
    monoBelow: hertz.optional(),
    /** Pull the level down at each note start of the named parts (sidechain). */
    duck: z
        .object({
            by: z.array(z.string()).min(1),
            depth: z.number().min(0).max(1),
            attack: z.number().min(0).max(200).optional(),
            hold: z.number().min(0).max(1000).optional(),
            release: z.number().positive().max(5000),
        })
        .optional(),
    /** Send level into the shared room. */
    reverb: z.number().min(0).max(2).optional(),
    /** Output gain in dB. */
    gain: z.number().min(-60).max(24).optional(),
});

export const SYNTH_LANES = ["cutoff", "pitch", "vowel", "fm", "lfoRate"] as const;

/**
 * A parameter that moves over score time. Synth lanes add to the patch: cutoff in octaves, pitch in semitones,
 * vowel in positions, fm as a fraction of the index, lfoRate as a factor. Part lanes: level in dB, lowpass and
 * highpass in Hz.
 */
export const laneSchema = z.object({
    target: z.enum([...SYNTH_LANES, "level", "lowpass", "highpass"]),
    points: z.array(z.tuple([z.number().finite().min(0), z.number().finite()])).min(1),
    /** Keep each value until the next point instead of a straight line between them. */
    hold: z.boolean().optional(),
});

/** One shared room that parts send into with `effects.reverb`. */
export const roomSchema = z.object({
    /** 0 to 1: the length of the tail. */
    size: z.number().min(0).max(1),
    /** 0 to 1: how fast the high end of the tail dies. */
    damp: z.number().min(0).max(1),
    /** Milliseconds before the room answers. */
    predelay: z.number().min(0).max(500).optional(),
    highpass: hertz.optional(),
    lowpass: hertz.optional(),
    /** Return level in dB. */
    level: z.number().min(-60).max(24).optional(),
});

export const MIN_LUFS = -36;
export const MAX_LUFS = -6;

export const masterSchema = z.object({
    /** Integrated loudness target. A command-line target wins over it. */
    lufs: z.number().min(MIN_LUFS).max(MAX_LUFS).optional(),
    /** True-peak ceiling in dB. */
    peak: z.number().min(-12).max(-0.5).optional(),
    /** Reach the target through a clipper and a limiter. Without it a score that is too dynamic is refused. */
    limiter: z.boolean().default(false),
    /** How many dB over the ceiling the clipper passes on to the limiter. */
    clip: z.number().min(0).max(12).optional(),
});

/** Where a part's sound comes from. */
export const sourceSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("soundfont"),
        program: z.number().int().min(0).max(127),
        percussion: z.boolean().default(false),
    }),
    z.object({
        kind: z.literal("synth"),
        /** A preset name (`tools music presets`) or a whole patch. */
        patch: z.union([z.string().min(1), patchSchema]),
    }),
]);

const looseObject = z.record(z.string(), z.unknown());

/** Scores written before 2026-11-15 hold `program` and `percussion` flat on the part. */
export function migratePart(raw: unknown): unknown {
    const part = looseObject.safeParse(raw);

    if (!part.success || "source" in part.data || part.data.program === undefined) {
        return raw;
    }

    const { program, percussion, ...rest } = part.data;
    return { ...rest, source: { kind: "soundfont", program, percussion: percussion ?? false } };
}

export const partSchema = z.preprocess(
    migratePart,
    z.object({
        name: z.string(),
        source: sourceSchema,
        volume: z.number().int().min(1).max(127).default(100),
        pan: z.number().int().min(0).max(127).default(64),
        notes: z.array(noteSchema),
        effects: effectsSchema.optional(),
        lanes: z.array(laneSchema).max(8).optional(),
    })
);

export const MAX_PARTS = 32;

export const scoreSchema = z
    .object({
        key: z.string().min(1),
        title: z.string().min(1),
        bpm: z.number().finite().min(20).max(400),
        seconds: z.number().finite().positive().max(3600),
        end: z.number().finite().positive(),
        parts: z.array(partSchema).min(1).max(MAX_PARTS),
        room: roomSchema.optional(),
        master: masterSchema.optional(),
    })
    .superRefine((score, context) => {
        if (score.end > score.seconds) {
            context.addIssue({ code: "custom", path: ["end"], message: "Written end exceeds score duration" });
        }

        const names = new Set(score.parts.map((part) => part.name));

        for (const [partIndex, part] of score.parts.entries()) {
            for (const [noteIndex, note] of part.notes.entries()) {
                if (note.at + note.duration > score.seconds + 0.000001) {
                    context.addIssue({
                        code: "custom",
                        path: ["parts", partIndex, "notes", noteIndex],
                        message: "Note extends past score duration",
                    });
                }
            }

            for (const name of part.effects?.duck?.by ?? []) {
                if (!names.has(name)) {
                    context.addIssue({
                        code: "custom",
                        path: ["parts", partIndex, "effects", "duck", "by"],
                        message: `Duck names an unknown part: ${name}`,
                    });
                }
            }

            if (part.effects?.reverb && !score.room) {
                context.addIssue({
                    code: "custom",
                    path: ["parts", partIndex, "effects", "reverb"],
                    message: "A reverb send needs score.room",
                });
            }

            for (const [laneIndex, lane] of (part.lanes ?? []).entries()) {
                if (part.source.kind !== "synth" && SYNTH_LANES.some((target) => target === lane.target)) {
                    context.addIssue({
                        code: "custom",
                        path: ["parts", partIndex, "lanes", laneIndex, "target"],
                        message: `Lane ${lane.target} needs a synth source`,
                    });
                }
            }
        }
    });

export type Score = z.infer<typeof scoreSchema>;
export type Note = z.infer<typeof noteSchema>;
export type ScorePart = Score["parts"][number];
export type Source = z.infer<typeof sourceSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type Oscillator = z.infer<typeof oscillatorSchema>;
export type Patch = z.infer<typeof patchSchema>;
export type Lfo = NonNullable<Patch["lfos"]>[number];
export type Effects = z.infer<typeof effectsSchema>;
export type EqBand = NonNullable<Effects["eq"]>[number];
export type Lane = z.infer<typeof laneSchema>;
export type Room = z.infer<typeof roomSchema>;
export type Master = z.infer<typeof masterSchema>;

export interface AudioMeasurement {
    file: string;
    seconds: number;
    lufs: number;
    truePeakDb: number;
    rmsDb: { low: number | null; mid: number | null; high: number | null };
    sha256: string;
}

export interface Placement {
    trim: number;
    delay: number;
    fadeOutAt: number;
}

export interface MixOptions {
    video: string;
    music: string;
    output: string;
    end: number;
    volume?: number;
    fadeIn?: number;
    fadeOut?: number;
    duck?: boolean;
    threshold?: number;
    ratio?: number;
    attackMs?: number;
    releaseMs?: number;
    overwrite?: boolean;
}
