import { z } from "zod";

/**
 * The Moment engine's shapes that a client names: a target, the Moment the engine answers, and why it cannot play.
 * Kept apart from moment.ts, so the Meetings service's descriptor (service/api.ts, which every `tools meetings` read
 * imports) names them without loading the engine.
 */

/** A point in a transcript line: the line's start (its address), its index as a hint, and how far into its text. */
export const linePointSchema = z.object({
    /** When the line starts on the transcript clock; it finds the line again when indexes differ. */
    atSec: z.number().min(0),
    /** The line's index in the source transcript, when the caller knows it. */
    line: z.number().int().min(0).optional(),
    /** How far into the line's text, 0 (its start) to 1 (its end); the line's time is spread over its text. */
    fraction: z.number().min(0).max(1).optional(),
});
export type LinePoint = z.infer<typeof linePointSchema>;

/**
 * What a Moment is of. `item` takes any item id (`i42`) or a question's number (`Q12`, `12`); a question plays what
 * `listen` plays. `selection` is words picked in the transcript (R43: "Clip 5s"). `stretch` is one speaker's turn
 * around a time (R20, R21); with `speaker`, that speaker's turn at or after the time.
 */
export const momentTargetSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("item"), id: z.string().trim().min(1) }),
    z.object({ kind: z.literal("time"), atSec: z.number().min(0) }),
    z.object({ kind: z.literal("range"), fromSec: z.number().min(0), toSec: z.number().min(0) }),
    z.object({ kind: z.literal("selection"), from: linePointSchema, to: linePointSchema }),
    z.object({ kind: z.literal("stretch"), atSec: z.number().min(0), speaker: z.string().trim().min(1).optional() }),
]);
export type MomentTarget = z.infer<typeof momentTargetSchema>;

/** Why a target has no Moment. The code lets a client tell a wrong target from a broken meeting. */
export const MOMENT_ERROR_CODES = [
    "unknown-item",
    "no-time",
    "bad-range",
    "unknown-line",
    "no-speech",
    "past-the-end",
    /** An item's or a speaker turn's stretch is longer than `playback.listen.longestClipSec`: show it, do not play it. */
    "too-long",
] as const;
export type MomentErrorCode = (typeof MOMENT_ERROR_CODES)[number];

/** Why a Moment that exists cannot play here and now (G-STATE-1): a disabled play control shows it. */
export const MOMENT_STATE_CODES = [
    /** No linked source keeps the recording on this Mac. */
    "no-audio",
    /** The meeting is still being recorded: its audio is not final yet. */
    "recording",
    /** ffmpeg (which cuts the clip) is not installed. */
    "no-ffmpeg",
] as const;
export type MomentStateCode = (typeof MOMENT_STATE_CODES)[number];

const toneSoundSchema = z.object({ hz: z.number(), sec: z.number(), volume: z.number() });

/** One frame of a Moment's spot (`MomentFrame`). */
export const momentFrameSchema = z.object({
    file: z.string(),
    path: z.string(),
    at: z.string(),
    meetingSec: z.number(),
    displayId: z.number().optional(),
    hit: z
        .object({
            text: z.string(),
            box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
        })
        .optional(),
});

/** A Moment as the engine answers it (`Moment`, moment.ts); the asked spot is `spotSec`, the tone's time `tone.atSec`. */
export const momentSchema = z.object({
    meeting: z.string(),
    target: momentTargetSchema,
    label: z.string(),
    fromSec: z.number(),
    toSec: z.number(),
    padSec: z.number(),
    startSec: z.number(),
    endSec: z.number(),
    spotSec: z.number(),
    tone: z.object({ atSec: z.number(), sound: toneSoundSchema }).optional(),
    delaySec: z.number(),
    repeatGapSec: z.number().optional(),
    screen: z.array(momentFrameSchema).optional(),
});
