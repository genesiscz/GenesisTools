import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingsConfig, ToneSound } from "@genesiscz/utils/meetings/config";
import {
    type MeetingItem,
    type MeetingRecord,
    type MeetingStore,
    MOMENTS_FOLDER,
} from "@genesiscz/utils/meetings/record";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { z } from "zod";
import { type ClipPlan, cutClip } from "./audio";
import { OpenedMeeting } from "./opened-meeting";
import { PAST_END_GRACE_SEC } from "./players";
import {
    askedSpotSec,
    heardClip,
    type QuestionItem,
    questionIdOf,
    questionLabel,
    questionOccurrence,
} from "./questions";

const { log } = logger.scoped("meetings-moment");

/**
 * The Moment engine: what a meeting plays for one target. A Moment is a bounded span of the meeting's audio with its
 * asked spot, its pad and its tone; `listen`, `listen --clip-out`, `play` and the Meetings window all ask this module,
 * so the span, pad, spot and tone policy lives in one place. It never plays sound: `cutMoment` writes a WAV that a
 * surface plays its own way (the terminal through a player process, the window in process).
 */

export type ListenSettings = MeetingsConfig["global"]["playback"]["listen"];

/** Audio after a voice's span, and before it besides the tone's lead. */
export const SPEAKER_PAD_SEC = 0.3;

/** Audio around a span when `playback.listen.padSec` is not set yet (the smaller choice the first `listen` offers). */
export const DEFAULT_PAD_SEC = 5;

/** A term item with no line found for its words hears this much from its time (questions.ts asks a term the same). */
const TERM_SPAN_SEC = 4;

/** A single time hears the rest of the line it falls in, at least `min` and at most `max` seconds. */
const TIME_SPAN_SEC = { min: 4, max: 15 } as const;

/** A point in a transcript line: the line's start (its address), its index as a hint, and how far into its text. */
const linePointSchema = z.object({
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

/** The frame on one display at a Moment's spot (R41): the screen as it was while those words were said. */
export interface MomentFrame {
    /** Relative to the meeting folder (`frames/16-32-42-232-d4.jpg`). */
    file: string;
    path: string;
    /** Wall time of the frame. */
    at: string;
    /** Seconds on the transcript clock. */
    meetingSec: number;
    displayId?: number;
}

export interface Moment {
    meeting: string;
    target: MomentTarget;
    /** How a person names it: `Q12`, `i42`, `1:49:48`, `1:49:48–1:50:02`, `Speaker 2 05:09–05:31`. */
    label: string;
    /** The heard stretch on the transcript clock, before the pad. */
    fromSec: number;
    toSec: number;
    /** Audio kept on each side of the heard stretch. */
    padSec: number;
    /** Where the clip starts and ends on the transcript clock: the stretch with its pad, never before 0. */
    startSec: number;
    endSec: number;
    /** The asked spot: where the heard words fall, where a voice starts, the time asked for. */
    spotSec: number;
    /** The tone just before the spot (a time in the recording); absent when `playback.listen.tone.enabled` is off. */
    tone?: { atSec: number; sound: ToneSound };
    /** Seconds a surface waits before it plays the clip, so what it shows is read first. */
    delaySec: number;
    /** The pause before the clip plays again; absent when `playback.listen.repeat` is off. */
    repeatGapSec?: number;
    /** The frame on each recorded display at the spot; absent without a screen recording there. */
    screen?: MomentFrame[];
}

/** Why a target has no Moment. The code lets a client tell a wrong target from a broken meeting. */
export const MOMENT_ERROR_CODES = [
    "unknown-item",
    "no-time",
    "bad-range",
    "unknown-line",
    "no-speech",
    "past-the-end",
] as const;
export type MomentErrorCode = (typeof MOMENT_ERROR_CODES)[number];

export class MomentError extends Error {
    readonly code: MomentErrorCode;

    constructor(code: MomentErrorCode, message: string) {
        super(message);
        this.name = "MomentError";
        this.code = code;
    }
}

const linesCache = new WeakMap<readonly TranscriptEntry[], TranscriptLines>();

function linesOf(transcript: readonly TranscriptEntry[] | TranscriptLines): TranscriptLines {
    if (transcript instanceof TranscriptLines) {
        return transcript;
    }

    const cached = linesCache.get(transcript);

    if (cached) {
        return cached;
    }

    const lines = new TranscriptLines(transcript);
    linesCache.set(transcript, lines);
    return lines;
}

/** Where the transcript's speech ends: the end of its last timed line; undefined for a transcript with no times. */
function speechEndSec(lines: TranscriptLines): number | undefined {
    let end: number | undefined;

    for (let index = 0; index < lines.entries.length; index++) {
        const lineEnd = lines.end(index);

        if (lineEnd !== undefined && (end === undefined || lineEnd > end)) {
            end = lineEnd;
        }
    }

    return end;
}

/** The timed line that is spoken at `sec`, from its start to its end. */
function lineAt(lines: TranscriptLines, sec: number): number | undefined {
    for (let index = 0; index < lines.entries.length; index++) {
        const span = lines.span(index);

        if (span && sec >= span.fromSec && sec < span.toSec) {
            return index;
        }
    }

    return undefined;
}

/** One speaker's turn: consecutive timed lines under one label, from the first's start to the last's end. */
export interface SpeakerStretch {
    speaker: string;
    fromSec: number;
    toSec: number;
    firstLine: number;
    lastLine: number;
}

/** Every speaker's turns in transcript order (R21: one section per stretch a speaker talks). */
export function speakerStretches(transcript: readonly TranscriptEntry[] | TranscriptLines): SpeakerStretch[] {
    const lines = linesOf(transcript);
    const stretches: SpeakerStretch[] = [];

    lines.entries.forEach((entry, index) => {
        const span = lines.span(index);

        if (!span || !entry.text.trim()) {
            return;
        }

        const last = stretches.at(-1);

        if (last && last.speaker === entry.speaker) {
            last.toSec = span.toSec;
            last.lastLine = index;
            return;
        }

        stretches.push({
            speaker: entry.speaker,
            fromSec: span.fromSec,
            toSec: span.toSec,
            firstLine: index,
            lastLine: index,
        });
    });

    return stretches;
}

/** A time or a range named in a text, with where it stands in the text (UTF-16 offsets, end exclusive). */
export interface MomentMention {
    start: number;
    end: number;
    text: string;
    target: Extract<MomentTarget, { kind: "time" | "range" }>;
}

const CLOCK_IN_TEXT = /(?<![\d:.])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g;
/** What joins two times into one range: a dash, or "to", "and", "until" (and the Czech "do", "a", "až"). */
const RANGE_JOIN = /^\s*(?:[-–—]|to|and|until|till|do|a|až)\s*$/iu;

/**
 * The times a text names, in order: "from 05:09 to 05:31", "between 1:02:10 and 1:02:40" and "05:09–05:31" are ranges,
 * a lone "1:49:48" is a time. A question's text is how it names the moments that settle it (R17: every time in it
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

        if (to && to.sec > from.sec && RANGE_JOIN.test(text.slice(from.end, to.start))) {
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

/**
 * The heard stretch of a target before any pad. `voice` pads by the tone's lead plus `SPEAKER_PAD_SEC` (the voice from
 * the tone on); `around` pads by the pad setting on both sides.
 */
interface Span {
    fromSec: number;
    toSec: number;
    spotSec: number;
    pad: "voice" | "around";
    label: string;
}

const range = (fromSec: number, toSec: number): string => `${formatClock(fromSec)}–${formatClock(toSec)}`;

function questionSpan(record: MeetingRecord, question: QuestionItem, lines: TranscriptLines): Span {
    // A word question plays the spot of its own occurrence, so a word late in a long line is in the clip; a speaker
    // question plays only the asked voice, from the tone on.
    const occurrence = questionOccurrence(record, question);
    const heard = (question.about === "speaker" ? undefined : heardClip(question, lines, occurrence)) ??
        question.clip ?? { fromSec: question.fromSec, toSec: question.toSec };
    return {
        ...heard,
        spotSec: askedSpotSec(question, lines, occurrence),
        pad: question.about === "speaker" ? "voice" : "around",
        label: questionLabel(record, question.id),
    };
}

/** Refuses a time more than `PAST_END_GRACE_SEC` after the transcript's last speech, as `play --at` does. */
function refuseAfterSpeech(sec: number, end: number | undefined): void {
    if (end !== undefined && sec > end + PAST_END_GRACE_SEC) {
        throw new MomentError(
            "past-the-end",
            `${formatClock(sec)} is after the meeting's last speech (${formatClock(end)}).`
        );
    }
}

/** A single time: the rest of the line it falls in, kept between the time span's bounds and inside the speech. */
function timeSpan(lines: TranscriptLines, atSec: number, label: string): Span {
    const end = speechEndSec(lines);
    refuseAfterSpeech(atSec, end);
    const index = lineAt(lines, atSec);
    const lineEnd = index === undefined ? undefined : lines.end(index);
    const wanted = Math.min(Math.max(lineEnd ?? atSec, atSec + TIME_SPAN_SEC.min), atSec + TIME_SPAN_SEC.max);
    const toSec = end === undefined ? wanted : Math.max(atSec, Math.min(wanted, end));
    return { fromSec: atSec, toSec, spotSec: atSec, pad: "around", label };
}

function itemSpan(record: MeetingRecord, item: MeetingItem, lines: TranscriptLines): Span {
    switch (item.kind) {
        case "question":
            return questionSpan(record, item, lines);
        case "speaker-range": {
            // A range ends where its last line starts; the clip hears that line to its end.
            const lineEnd = item.evidence?.endSec;
            const toSec = typeof lineEnd === "number" ? Math.max(item.toSec, lineEnd) : item.toSec;
            return { fromSec: item.fromSec, toSec, spotSec: item.fromSec, pad: "voice", label: item.id };
        }
        case "label":
            return { fromSec: item.fromSec, toSec: item.toSec, spotSec: item.fromSec, pad: "voice", label: item.id };
        case "join":
            return timeSpan(lines, item.atSec, item.id);
        case "term": {
            if (item.atSec === undefined) {
                throw new MomentError("no-time", `${item.id} ("${item.heard}") has no time in the recording.`);
            }

            const atSec = item.atSec;
            const transcriptLine = item.evidence?.transcriptLine;
            const said = lines
                .occurrences({ heard: item.heard, fromSec: atSec, toSec: atSec })
                .find((one) => typeof transcriptLine !== "number" || one.index === transcriptLine);
            const heard = (said ? lines.clip(said) : undefined) ?? { fromSec: atSec, toSec: atSec + TERM_SPAN_SEC };
            const spotSec = (said ? lines.spotSec(said) : undefined) ?? atSec;
            return { ...heard, spotSec, pad: "around", label: item.id };
        }
    }
}

/** A point in a line to seconds: the line found by its address, its time spread over its text. */
function pointSec(lines: TranscriptLines, point: LinePoint, edge: "from" | "to"): { sec: number; index: number } {
    const found = lines.resolve({ atSec: point.atSec, ...(point.line === undefined ? {} : { line: point.line }) });

    if (found.kind !== "found") {
        throw new MomentError(
            "unknown-line",
            found.kind === "ambiguous"
                ? `Several lines start at ${formatClock(point.atSec)}; name the line too.`
                : `No line starts at ${formatClock(point.atSec)}.`
        );
    }

    const span = lines.span(found.index)!;
    const fraction = point.fraction ?? (edge === "from" ? 0 : 1);
    return { sec: span.fromSec + fraction * (span.toSec - span.fromSec), index: found.index };
}

function targetSpan(record: MeetingRecord, target: MomentTarget, lines: TranscriptLines): Span {
    switch (target.kind) {
        case "item": {
            const id = questionIdOf(record, target.id);
            const item = record.items.find((one) => one.id === id);

            if (!item) {
                throw new MomentError("unknown-item", `No item ${target.id} in ${record.id}.`);
            }

            return itemSpan(record, item, lines);
        }
        case "time":
            return timeSpan(lines, target.atSec, formatClock(target.atSec));
        case "range": {
            if (target.toSec <= target.fromSec) {
                throw new MomentError(
                    "bad-range",
                    `A range ends after it starts (${formatClock(target.fromSec)} to ${formatClock(target.toSec)}).`
                );
            }

            refuseAfterSpeech(target.fromSec, speechEndSec(lines));
            return {
                fromSec: target.fromSec,
                toSec: target.toSec,
                spotSec: target.fromSec,
                pad: "around",
                label: range(target.fromSec, target.toSec),
            };
        }
        case "selection": {
            const from = pointSec(lines, target.from, "from");
            const to = pointSec(lines, target.to, "to");

            if (to.sec <= from.sec) {
                throw new MomentError("bad-range", "A selection ends after it starts.");
            }

            return {
                fromSec: from.sec,
                toSec: to.sec,
                spotSec: from.sec,
                pad: "around",
                label: range(from.sec, to.sec),
            };
        }
        case "stretch": {
            const stretches = speakerStretches(lines).filter(
                (one) => target.speaker === undefined || one.speaker === target.speaker
            );
            const found =
                stretches.find((one) => target.atSec >= one.fromSec && target.atSec < one.toSec) ??
                stretches.find((one) => one.fromSec >= target.atSec);

            if (!found) {
                const who = target.speaker === undefined ? "Nobody" : `"${target.speaker}" never`;
                throw new MomentError("no-speech", `${who} speaks at or after ${formatClock(target.atSec)}.`);
            }

            return {
                fromSec: found.fromSec,
                toSec: found.toSec,
                spotSec: found.fromSec,
                pad: "voice",
                label: `${found.speaker} ${range(found.fromSec, found.toSec)}`,
            };
        }
    }
}

export interface MomentInput {
    record: MeetingRecord;
    transcript: readonly TranscriptEntry[] | TranscriptLines;
    listen: ListenSettings;
    /** Audio around an `around` span; else `listen.padSec`, else `DEFAULT_PAD_SEC`. */
    padSec?: number;
}

function momentOf(input: MomentInput, target: MomentTarget, span: Span): Moment {
    const { listen } = input;
    const padSec =
        span.pad === "voice"
            ? listen.tone.leadSec + SPEAKER_PAD_SEC
            : (input.padSec ?? listen.padSec ?? DEFAULT_PAD_SEC);
    // The tone marks the spot when the clip holds it, else the start of what is heard.
    const inClip = span.spotSec >= span.fromSec - padSec && span.spotSec <= span.toSec + padSec;
    const startSec = Math.max(0, span.fromSec - padSec);
    return {
        meeting: input.record.id,
        target,
        label: span.label,
        fromSec: span.fromSec,
        toSec: span.toSec,
        padSec,
        startSec,
        endSec: span.toSec + padSec,
        spotSec: span.spotSec,
        ...(listen.tone.enabled
            ? {
                  tone: {
                      atSec: (inClip ? span.spotSec : span.fromSec) - listen.tone.leadSec,
                      sound: listen.tone.sound,
                  },
              }
            : {}),
        delaySec: listen.delaySec,
        ...(listen.repeat ? { repeatGapSec: listen.repeatGapSec } : {}),
    };
}

/** The Moment of one target. Throws a `MomentError` for a target the meeting does not have. Reads nothing. */
export function planMoment(input: MomentInput & { target: MomentTarget }): Moment {
    return momentOf(input, input.target, targetSpan(input.record, input.target, linesOf(input.transcript)));
}

/**
 * The Moment of an item object, which `listen` holds while it asks (a question it has just split, say). The same as
 * `planMoment` with `{ kind: "item", id }` for an item in the record.
 */
export function itemMoment(input: MomentInput & { item: MeetingItem }): Moment {
    const target: MomentTarget = { kind: "item", id: input.item.id };
    return momentOf(input, target, itemSpan(input.record, input.item, linesOf(input.transcript)));
}

/** What `cutClip` cuts for a Moment: the same numbers `listen --clip-out --json` prints, plus the tone's sound. */
export function clipPlan(moment: Moment): ClipPlan {
    return {
        fromSec: moment.fromSec,
        toSec: moment.toSec,
        padSec: moment.padSec,
        ...(moment.tone ? { toneAtSec: moment.tone.atSec, toneSound: moment.tone.sound } : {}),
    };
}

/** Cuts a Moment to a WAV file with its tone. Needs ffmpeg; tests pass `cut`. */
export async function cutMoment(
    moment: Moment,
    options: { audioPath: string; outPath: string; cut?: typeof cutClip }
): Promise<void> {
    await (options.cut ?? cutClip)({ audioPath: options.audioPath, outPath: options.outPath, ...clipPlan(moment) });
}

/**
 * Where a Moment's clip goes in its meeting folder: `moments/<label>-<key>.wav`. The key comes from what the clip
 * holds, so the same Moment always writes the same file and a different one never overwrites it.
 */
export function momentClipPath(folder: string, moment: Moment): string {
    const name = moment.label.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "moment";
    const key = Bun.hash(SafeJSON.stringify([moment.startSec, moment.endSec, moment.tone ?? null])).toString(36);
    return join(folder, MOMENTS_FOLDER, `${name}-${key}.wav`);
}

/** The frame on each display at `atSec`; none without a screen recording at that time. Never throws. */
export async function momentFrames(store: MeetingStore, record: MeetingRecord, atSec: number): Promise<MomentFrame[]> {
    const folder = store.folder(record.id);

    if (!existsSync(join(folder, "ocr.jsonl"))) {
        return [];
    }

    try {
        // Loaded here: listen asks for Moments without a screen and should not load the OCR readers.
        const { meetingScreen } = await import("./screen-boxes");
        const screen = await meetingScreen({ store, record, atSec, windowSec: 0 });
        return screen.displays.flatMap((display) => {
            const frame = display.frames.at(-1);
            return frame
                ? [
                      {
                          file: frame.file,
                          path: join(folder, frame.file),
                          at: frame.at,
                          meetingSec: Math.round((Date.parse(frame.at) - screen.zeroMs) / 100) / 10,
                          ...(frame.displayId === undefined ? {} : { displayId: frame.displayId }),
                      },
                  ]
                : [];
        });
    } catch (err) {
        log.debug({ err, meeting: record.id }, "no screen frame for the moment");
        return [];
    }
}

/**
 * The Moment of a target in a saved meeting: its source transcript and the playback settings are read, and the frame
 * on each display at the spot is named when the screen was recorded (R41). `screen: false` skips the frame lookup.
 */
export async function openMoment(options: OpenMomentOptions): Promise<Moment> {
    return await momentIn(options.opened ?? OpenedMeeting.of(options.store, options.record), options);
}

export interface OpenMomentOptions {
    store: MeetingStore;
    record: MeetingRecord;
    target: MomentTarget;
    padSec?: number;
    screen?: boolean;
    /** The meeting already opened by the caller (a service that holds it, a test with its own source). */
    opened?: OpenedMeeting;
}

async function momentIn(opened: OpenedMeeting, options: OpenMomentOptions): Promise<Moment> {
    const { store, record } = options;
    const [meeting, config] = await Promise.all([opened.meeting(), opened.config()]);
    const moment = planMoment({
        record,
        transcript: meeting.transcript,
        listen: config.global.playback.listen,
        target: options.target,
        ...(options.padSec === undefined ? {} : { padSec: options.padSec }),
    });

    if (options.screen === false) {
        return moment;
    }

    const screen = await momentFrames(store, record, moment.spotSec);
    return screen.length > 0 ? { ...moment, screen } : moment;
}

/** A Moment cut to its WAV in the meeting folder (`momentClipPath`): what `play --clip` prints and the window plays. */
export async function clipMoment(
    options: OpenMomentOptions & { cut?: typeof cutClip }
): Promise<Moment & { path: string }> {
    const { store, record } = options;
    const opened = options.opened ?? OpenedMeeting.of(store, record);
    const moment = await momentIn(opened, options);
    const path = momentClipPath(store.folder(record.id), moment);
    // Cut beside the clip and rename it over the clip: a player that reads the clip (the window, a second play) never
    // gets it half written, and two cuts of one Moment at once each publish a whole file.
    const partial = join(dirname(path), `.${basename(path, ".wav")}-${randomUUID()}.wav`);

    try {
        await cutMoment(moment, {
            audioPath: await opened.audioPath(),
            outPath: partial,
            ...(options.cut ? { cut: options.cut } : {}),
        });
        renameSync(partial, path);
    } catch (error) {
        removePartialClip(partial);
        throw error;
    }

    return { ...moment, path };
}

/** Best-effort removal of a failed cut's partial file; never masks the failure that caused it. */
function removePartialClip(partial: string): void {
    if (!existsSync(partial)) {
        return;
    }

    try {
        unlinkSync(partial);
    } catch (error) {
        log.debug({ error, partial }, "a failed Moment cut left its partial clip");
    }
}
