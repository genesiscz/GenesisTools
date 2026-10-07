import { z } from "zod";

export const VIDEO_FPS = [1, 2, 3, 4] as const;
export const VIDEO_GROUPS = [1, 4, 8, 16, 32] as const;
export const videoSettingsSchema = z
    .object({
        fps: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
        framesPerImage: z.union([z.literal(1), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]),
        minimumDifferencePct: z.number().finite().min(0).max(100).default(0),
    })
    .strict();

export type VideoSettings = z.infer<typeof videoSettingsSchema>;
export interface VideoInfo {
    path: string;
    durationUs: number;
    width: number;
    height: number;
    displayWidth: number;
    displayHeight: number;
    rotation: number;
    bytes: number;
    codec: string;
    colorSpace?: string;
    colorTransfer?: string;
}
export interface VideoFrame {
    id: string;
    requestedUs: number;
    actualUs: number;
    sourceIndex: number;
    path: string;
    kept: boolean;
    differencePct: number | null;
    comparedToId: string | null;
}
export interface VideoSheet {
    path: string;
    frameIds: string[];
    firstUs: number;
    lastUs: number;
    columns: number;
    rows: number;
}
export interface VideoManifest {
    version: 1;
    id: string;
    source: VideoInfo & { sha256: string };
    settings: VideoSettings;
    frames: VideoFrame[];
    sheets: VideoSheet[];
    counts: { candidates: number; kept: number; skipped: number; images: number; lastImageFrames: number };
    manifestPath: string;
    createdAt: string;
}
export interface VideoProgress {
    phase: "probing" | "extracting" | "comparing" | "composing" | "ready";
    completed: number;
    total: number;
}

const videoInfoSchema = z.object({
    path: z.string(),
    durationUs: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    displayWidth: z.number().int().positive(),
    displayHeight: z.number().int().positive(),
    rotation: z.number(),
    bytes: z.number(),
    codec: z.string(),
    colorSpace: z.string().optional(),
    colorTransfer: z.string().optional(),
    sha256: z.string(),
});
export const videoManifestSchema = z.object({
    version: z.literal(1),
    id: z.string().uuid(),
    source: videoInfoSchema,
    settings: videoSettingsSchema,
    frames: z
        .array(
            z.object({
                id: z.string(),
                requestedUs: z.number(),
                actualUs: z.number(),
                sourceIndex: z.number().int(),
                path: z.string(),
                kept: z.boolean(),
                differencePct: z.number().nullable(),
                comparedToId: z.string().nullable(),
            })
        )
        .min(1)
        .max(2400),
    sheets: z
        .array(
            z.object({
                path: z.string(),
                frameIds: z.array(z.string()).min(1).max(32),
                firstUs: z.number(),
                lastUs: z.number(),
                columns: z.number(),
                rows: z.number(),
            })
        )
        .min(1)
        .max(2400),
    counts: z.object({
        candidates: z.number(),
        kept: z.number(),
        skipped: z.number(),
        images: z.number(),
        lastImageFrames: z.number(),
    }),
    manifestPath: z.string(),
    createdAt: z.string(),
});
