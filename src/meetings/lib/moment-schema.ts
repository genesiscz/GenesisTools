import { TONE_PRESET_NAMES } from "@genesiscz/utils/meetings/config";
import { parseClock } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";
import type { ToneSound } from "./tone-sound";

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
    /** Kept for older answers: since 2026-11-11 a longer item or speaker turn plays its first `longestClipSec` instead. */
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

/**
 * A tone's sound as a Moment names it (`ToneSound`, tone-sound.ts): a sine of `hz`, or a sound file (`file`, `hz` 0),
 * `sec` long at `volume`; `preset` names the preset it came from.
 */
export const toneSoundSchema = z.object({
    hz: z.number(),
    sec: z.number(),
    volume: z.number(),
    file: z.string().optional(),
    preset: z.enum(TONE_PRESET_NAMES).optional(),
}) satisfies z.ZodType<ToneSound>;

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
    /** The pad after the heard stretch, present only when it differs from `padSec`. */
    padAfterSec: z.number().optional(),
    startSec: z.number(),
    endSec: z.number(),
    spotSec: z.number(),
    tone: z.object({ atSec: z.number(), sound: toneSoundSchema }).optional(),
    delaySec: z.number(),
    repeatGapSec: z.number().optional(),
    screen: z.array(momentFrameSchema).optional(),
});

/** A time or a range named in a text, with where it stands in the text (UTF-16 offsets, end exclusive). */
export interface MomentMention {
    start: number;
    end: number;
    text: string;
    target: Extract<MomentTarget, { kind: "time" | "range" }>;
}

const CLOCK_IN_TEXT = /(?<![\d:.])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g;
/** What joins two times into one range: a dash, or "to", "until" (and the Czech "do", "až"). */
const RANGE_JOIN = /^\s*(?:[-–—]|to|until|till|do|až)\s*$/iu;
/** "and" (Czech "a") joins a range only after "between" ("mezi"): "at 10:00 and 10:30" names two times. */
const BETWEEN_JOIN = /^\s*(?:and|a)\s*$/iu;
const BETWEEN = /(?:between|mezi)\s*$/iu;

/**
 * The times a text names, in order: "from 05:09 to 05:31", "between 1:02:10 and 1:02:40" and "05:09–05:31" are ranges,
 * a lone "1:49:48" is a time, and "at 10:00 and 10:30" is two times. Every time is on the transcript clock: a time of
 * day ("the 14:30 standup") reads as a transcript time too, a known limit (WaveA-Handoff). A question's text is how it names the moments that settle it (R17: every time in it
 * plays; R38: "This answers 12:10–12:30" is a Moment the window pushes on its context stack, above the one playing).
 */
export function momentsInText(text: string): MomentMention[] {
    const clocks = [...text.matchAll(CLOCK_IN_TEXT)].flatMap((match) => {
        const sec = parseClock(match[0]);
        return sec === undefined ? [] : [{ start: match.index, end: match.index + match[0].length, sec }];
    });
    const mentions: MomentMention[] = [];

    for (let index = 0; index < clocks.length; index++) {
        const from = clocks[index]!;
        const to = clocks[index + 1];

        const joint = to ? text.slice(from.end, to.start) : "";
        const joins = RANGE_JOIN.test(joint) || (BETWEEN_JOIN.test(joint) && BETWEEN.test(text.slice(0, from.start)));

        if (to && to.sec > from.sec && joins) {
            mentions.push({
                start: from.start,
                end: to.end,
                text: text.slice(from.start, to.end),
                target: { kind: "range", fromSec: from.sec, toSec: to.sec },
            });
            index++;
            continue;
        }

        mentions.push({
            start: from.start,
            end: from.end,
            text: text.slice(from.start, from.end),
            target: { kind: "time", atSec: from.sec },
        });
    }

    return mentions;
}
