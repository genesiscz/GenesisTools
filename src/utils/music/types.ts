import { z } from "zod";

export const noteSchema = z.object({
    at: z.number().finite().min(0),
    duration: z.number().finite().positive(),
    midi: z.number().int().min(0).max(127),
    velocity: z.number().int().min(1).max(127),
});

export const scoreSchema = z
    .object({
        key: z.string().min(1),
        title: z.string().min(1),
        bpm: z.number().finite().min(20).max(400),
        seconds: z.number().finite().positive().max(3600),
        end: z.number().finite().positive(),
        parts: z
            .array(
                z.object({
                    name: z.string(),
                    program: z.number().int().min(0).max(127),
                    percussion: z.boolean().default(false),
                    volume: z.number().int().min(1).max(127).default(100),
                    pan: z.number().int().min(0).max(127).default(64),
                    notes: z.array(noteSchema),
                })
            )
            .min(1)
            .max(15),
    })
    .superRefine((score, context) => {
        if (score.end > score.seconds) {
            context.addIssue({ code: "custom", path: ["end"], message: "Written end exceeds score duration" });
        }

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
        }
    });

export type Score = z.infer<typeof scoreSchema>;
export type Note = z.infer<typeof noteSchema>;
export type ScorePart = Score["parts"][number];

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
