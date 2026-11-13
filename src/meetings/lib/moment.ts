import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    type ListenPads,
    listenPads,
    type MeetingsConfig,
    type ToneSoundSetting,
} from "@genesiscz/utils/meetings/config";
import {
    type MeetingItem,
    type MeetingRecord,
    type MeetingStore,
    MOMENTS_FOLDER,
} from "@genesiscz/utils/meetings/record";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { type ClipPlan, type CutControl, cutClip, probeAudio } from "./audio";
import { hasFrameIndex } from "./frame-index";
import type { LinePoint, MomentErrorCode, MomentTarget } from "./moment-schema";
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
import { resolveToneSound, sineToneSound, type ToneSound } from "./tone-sound";

const { log } = logger.scoped("meetings-moment");

export {
    type LinePoint,
    MOMENT_ERROR_CODES,
    type MomentErrorCode,
    type MomentMention,
    type MomentTarget,
    momentsInText,
    momentTargetSchema,
} from "./moment-schema";

/**
 * The Moment engine: what a meeting plays for one target. A Moment is a bounded span of the meeting's audio with its
 * asked spot, its pad and its tone; `listen`, `listen --clip-out`, `play` and the Meetings window all ask this module,
 * so the span, pad, spot and tone policy lives in one place. It never plays sound: `cutMoment` writes a WAV that a
 * surface plays its own way (the terminal through a player process, the window in process).
 */

export type ListenSettings = MeetingsConfig["global"]["playback"]["listen"];

/** Audio after a voice's span, and before it besides the tone's lead. */
export const SPEAKER_PAD_SEC = 0.3;

/**
 * Audio before and after a span when `playback.listen.padBeforeSec` and `padAfterSec` are not set yet (the smaller
 * choice the first `listen` offers).
 */
export const DEFAULT_PAD_SEC = 5;

/** A term item with no line found for its words hears this much from its time (questions.ts asks a term the same). */
const TERM_SPAN_SEC = 4;

/** A single time hears the rest of the line it falls in, at least `min` and at most `max` seconds. */
const TIME_SPAN_SEC = { min: 4, max: 15 } as const;

/** A voice's stretch shorter than this is one instant: a single time, or two times a rounding apart. */
const INSTANT_SEC = 1;

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
    /**
     * Where the Moment's words show on this frame (G-SCR-4): the OCR block's text and its box, normalized 0 to 1 with
     * the origin at the bottom left as Vision gives it. The frame with a hit comes first (G-SCR-1).
     */
    hit?: { text: string; box: { x: number; y: number; width: number; height: number } };
}

export interface Moment {
    meeting: string;
    target: MomentTarget;
    /** How a person names it: `Q12`, `i42`, `1:49:48`, `1:49:48–1:50:02`, `Speaker 2 05:09–05:31`. */
    label: string;
    /** The heard stretch on the transcript clock, before the pad. */
    fromSec: number;
    toSec: number;
    /** Audio kept before the heard stretch, and after it unless `padAfterSec` says otherwise. */
    padSec: number;
    /** Audio kept after the heard stretch, present only when it differs from `padSec` (`playback.listen.padAfterSec`). */
    padAfterSec?: number;
    /** Where the clip starts and ends on the transcript clock: the stretch with its pad, never before 0. */
    startSec: number;
    endSec: number;
    /** The asked spot: where the heard words fall, where a voice starts, the time asked for. */
    spotSec: number;
    /** The tone just before the spot (a time in the recording); absent when `playback.listen.tone.enabled` is off. */
    tone?: { atSec: number; sound: ToneSound };
    /** Seconds a surface waits before it plays the clip, so what it shows is read first. */
    delaySec: number;
    /** The pause before the clip plays again; absent when `playback.listen.repeat.enabled` is off. */
    repeatGapSec?: number;
    /** The frame on each recorded display at the spot; absent without a screen recording there. */
    screen?: MomentFrame[];
}

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
    const asked = (question.about === "speaker" ? undefined : heardClip(question, lines, occurrence)) ??
        question.clip ?? { fromSec: question.fromSec, toSec: question.toSec };
    const heard =
        question.about === "speaker"
            ? {
                  ...asked,
                  toSec:
                      question.clip || question.question.startsWith('Who says "')
                          ? asked.toSec
                          : Math.max(
                                asked.toSec,
                                ...lines.entries.flatMap((entry, index) =>
                                    entry.startSec !== undefined &&
                                    entry.startSec >= asked.fromSec &&
                                    entry.startSec <= asked.toSec
                                        ? [lines.end(index) ?? asked.toSec]
                                        : []
                                )
                            ),
              }
            : asked;
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

/** Where a single time's stretch ends: the end of the line it falls in, between the time span's bounds, inside the speech. */
function lineReachSec(lines: TranscriptLines, atSec: number): number {
    const end = speechEndSec(lines);
    const index = lineAt(lines, atSec);
    const lineEnd = index === undefined ? undefined : lines.end(index);
    const wanted = Math.min(Math.max(lineEnd ?? atSec, atSec + TIME_SPAN_SEC.min), atSec + TIME_SPAN_SEC.max);
    return end === undefined ? wanted : Math.max(atSec, Math.min(wanted, end));
}

/** A single time: the rest of the line it falls in, kept between the time span's bounds and inside the speech. */
function timeSpan(lines: TranscriptLines, atSec: number, label: string): Span {
    refuseAfterSpeech(atSec, speechEndSec(lines));
    return { fromSec: atSec, toSec: lineReachSec(lines, atSec), spotSec: atSec, pad: "around", label };
}

/**
 * Where a voice's stretch ends. A stretch asked at one instant (a "who says this?" with one time, a range of one
 * line with no known end) reaches the end of its line, as a single time does: its own 0 s played only the two pads
 * of a voice, a 1.4 s clip nobody can name a speaker from.
 */
function voiceEnd(lines: TranscriptLines, fromSec: number, toSec: number): number {
    return toSec - fromSec < INSTANT_SEC ? Math.max(toSec, lineReachSec(lines, fromSec)) : toSec;
}

function itemSpan(record: MeetingRecord, item: MeetingItem, lines: TranscriptLines): Span {
    switch (item.kind) {
        case "removal":
            return { fromSec: item.fromSec, toSec: item.toSec, spotSec: item.fromSec, pad: "voice", label: item.id };
        case "question":
            return questionSpan(record, item, lines);
        case "speaker-range": {
            // A range ends where its last line starts; the clip hears that line to its end.
            const lineEnd = item.evidence?.endSec;
            const toSec = voiceEnd(
                lines,
                item.fromSec,
                typeof lineEnd === "number" ? Math.max(item.toSec, lineEnd) : item.toSec
            );
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
    // Only a spoken line has a span: a hint that names a line with no words falls back to the line at the time.
    const found = lines.resolve(
        { atSec: point.atSec, ...(point.line === undefined ? {} : { line: point.line }) },
        (_entry, index) => lines.span(index) !== undefined
    );
    const span = found.kind === "found" ? lines.span(found.index) : undefined;

    if (found.kind !== "found" || !span) {
        throw new MomentError(
            "unknown-line",
            found.kind === "ambiguous"
                ? `Several lines start at ${formatClock(point.atSec)}; name the line too.`
                : `No line starts at ${formatClock(point.atSec)}.`
        );
    }

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
    /**
     * Audio before an `around` span, and after it unless `padAfterSec` is given; else the saved pads
     * (`listen.padBeforeSec`, `padAfterSec`), else `DEFAULT_PAD_SEC` on both sides.
     */
    padSec?: number;
    /** Audio after an `around` span. */
    padAfterSec?: number;
    /** At most this long from the span's start (the window's "Clip 5s" on a selection: 5); the pad stays. */
    lengthSec?: number;
    /**
     * The tone's sound as `resolveToneSound` made it. A caller whose `listen.tone.sound` is a sound file passes it (its
     * length is read from the file); a sine is made from the settings when absent.
     */
    toneSound?: ToneSound;
}

/** The audio an `around` span keeps on each side: the caller's, else the saved pads, else `DEFAULT_PAD_SEC`. */
function aroundPads(input: MomentInput): ListenPads {
    const saved = listenPads(input.listen) ?? { beforeSec: DEFAULT_PAD_SEC, afterSec: DEFAULT_PAD_SEC };
    const beforeSec = input.padSec ?? saved.beforeSec;
    const afterSec = input.padAfterSec ?? (input.padSec === undefined ? saved.afterSec : input.padSec);
    return { beforeSec, afterSec };
}

/** The tone's sound: the resolved one the caller passed, else the sine the settings name. */
function toneSoundOf(input: MomentInput): ToneSound {
    const sound = input.toneSound ?? sineToneSound(input.listen.tone.sound);

    if (!sound) {
        // A sound file's length is read from the file: the caller resolves it (`resolveToneSound`) before planning.
        throw new Error("The tone is a sound file: resolve it with resolveToneSound before planning the Moment.");
    }

    return sound;
}

function momentOf(input: MomentInput, target: MomentTarget, span: Span): Moment {
    const { listen } = input;
    const splitPart =
        target.kind === "item" &&
        input.record.items.some(
            (item) =>
                item.id === questionIdOf(input.record, target.id) &&
                item.kind === "question" &&
                item.question.startsWith('Who says "')
        );
    const voicePad = Math.max(splitPart ? 1.5 : 0, listen.tone.leadSec + SPEAKER_PAD_SEC);
    const pads = span.pad === "voice" ? { beforeSec: voicePad, afterSec: voicePad } : aroundPads(input);
    // The tone marks the spot when the clip holds it, else the start of what is heard.
    const inClip = span.spotSec >= span.fromSec - pads.beforeSec && span.spotSec <= span.toSec + pads.afterSec;
    const startSec = Math.max(0, span.fromSec - pads.beforeSec);
    return {
        meeting: input.record.id,
        target,
        label: span.label,
        fromSec: span.fromSec,
        toSec: span.toSec,
        padSec: pads.beforeSec,
        ...(pads.afterSec === pads.beforeSec ? {} : { padAfterSec: pads.afterSec }),
        startSec,
        endSec: span.toSec + pads.afterSec,
        spotSec: span.spotSec,
        ...(listen.tone.enabled
            ? {
                  tone: {
                      atSec: (inClip ? span.spotSec : span.fromSec) - listen.tone.leadSec,
                      sound: toneSoundOf(input),
                  },
              }
            : {}),
        delaySec: listen.delaySec,
        ...(listen.repeat.enabled ? { repeatGapSec: listen.repeat.gapSec } : {}),
    };
}

/** The Moment of one target. Throws a `MomentError` for a target the meeting does not have. Reads nothing. */
export function planMoment(input: MomentInput & { target: MomentTarget }): Moment {
    const whole = targetSpan(input.record, input.target, linesOf(input.transcript));
    const span =
        input.lengthSec === undefined
            ? whole
            : { ...whole, toSec: Math.min(whole.toSec, whole.fromSec + input.lengthSec) };
    return momentOf(input, input.target, clampTooLong(input.record, input.target, span, input.listen.longestClipSec));
}

/**
 * A stretch the data names (an item, a speaker's turn) longer than `longestSec` plays its first `longestSec`: a play
 * button always plays, and hearing the start is how a look-alike or a hint range is checked. The label says it is the
 * start ("first 30 s of 00:50"). It refused with `too-long` until 2026-11-11, which left the play button of a long
 * look-alike in "This also affects" with an error notice.
 * A question plays its own clip, and a range or a selection is bounded by the caller.
 */
function clampTooLong(record: MeetingRecord, target: MomentTarget, span: Span, longestSec: number): Span {
    const capped =
        target.kind === "stretch" ||
        (target.kind === "item" &&
            record.items.find((item) => item.id === questionIdOf(record, target.id))?.kind !== "question");

    if (!capped || span.toSec - span.fromSec <= longestSec) {
        return span;
    }

    return {
        ...span,
        label: `${span.label} (first ${longestSec} s of ${formatClock(span.toSec - span.fromSec)})`,
        toSec: span.fromSec + longestSec,
        spotSec: Math.min(span.spotSec, span.fromSec + longestSec),
    };
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
        ...(moment.padAfterSec === undefined ? {} : { padAfterSec: moment.padAfterSec }),
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

function clipName(moment: Moment): string {
    return moment.label.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "moment";
}

function clipKey(moment: Moment, extra: unknown[] = []): string {
    return Bun.hash(SafeJSON.stringify([moment.startSec, moment.endSec, moment.tone ?? null, ...extra])).toString(36);
}

/**
 * Where a Moment's clip went in its meeting folder before the clip cache: `moments/<label>-<key>.wav`. An old meeting
 * folder may still hold such clips; the window's revision tokens ignore the folder (`MOMENTS_FOLDER`).
 */
export function momentClipPath(folder: string, moment: Moment): string {
    return join(folder, MOMENTS_FOLDER, `${clipName(moment)}-${clipKey(moment)}.wav`);
}

/** The recording a clip is cut from, as its cache key names it: a changed file is a new key. */
export interface ClipSource {
    path: string;
    mtimeMs: number;
    size: number;
}

/** The clip cache (WaveB-Plan decision 10): `<genesis-tools>/meetings-cache/moments/<meeting>/`, size-capped. */
export function momentCacheDir(meeting?: string): string {
    return meeting ? toolDataDir("meetings-cache", "moments", meeting) : toolDataDir("meetings-cache", "moments");
}

/** The cache holds at most this much; the clips used longest ago go first. */
export const MOMENT_CACHE_BYTES = 500 * 1024 * 1024;

/** A tone file's time and size, so an edited sound file is a new clip key; nothing for a sine or a gone file. */
function toneFileVersion(moment: Moment): number[] {
    const file = moment.tone?.sound.file;

    if (!file || !existsSync(file)) {
        return [];
    }

    const { mtimeMs, size } = statSync(file);
    return [mtimeMs, size];
}

/**
 * Where a Moment's clip goes in the clip cache: `<label>-<key>.wav`, the key from what the clip holds (its span, its
 * tone, a tone file's version) and the recording (its path, time and size), so the same Moment of the same recording
 * is cut once (G16, G-PLAY-10).
 */
export function momentCachePath(moment: Moment, source: ClipSource): string {
    // Earlier clips dropped delayed-track timestamps. Keep those derived WAVs out of the corrected cache.
    const key = clipKey(moment, [
        "container-clock-v1",
        source.path,
        source.mtimeMs,
        source.size,
        ...toneFileVersion(moment),
    ]);
    return join(momentCacheDir(moment.meeting), `${clipName(moment)}-${key}.wav`);
}

/** Removes the clips used longest ago until the cache holds at most `capBytes`; returns how many went. Never throws. */
export function trimMomentCache(capBytes = MOMENT_CACHE_BYTES, root = momentCacheDir()): number {
    if (!existsSync(root)) {
        return 0;
    }

    const clips = readdirSync(root, { withFileTypes: true }).flatMap((folder) => {
        if (!folder.isDirectory()) {
            return [];
        }

        const dir = join(root, folder.name);
        return readdirSync(dir).flatMap((name) => {
            // A cut still in progress is a hidden partial file: never counted, never removed here.
            if (!name.endsWith(".wav") || name.startsWith(".")) {
                return [];
            }

            try {
                const stat = statSync(join(dir, name));
                return [{ path: join(dir, name), size: stat.size, usedMs: stat.mtimeMs }];
            } catch (error) {
                log.debug({ error, name }, "a cached clip went before it was counted");
                return [];
            }
        });
    });
    let total = clips.reduce((sum, clip) => sum + clip.size, 0);
    let removed = 0;

    for (const clip of clips.sort((a, b) => a.usedMs - b.usedMs)) {
        if (total <= capBytes) {
            break;
        }

        try {
            // A cache file the next play cuts again: no trash, no undo needed.
            unlinkSync(clip.path);
            total -= clip.size;
            removed += 1;
        } catch (error) {
            log.debug({ error, path: clip.path }, "a cached clip could not be removed");
        }
    }

    if (removed > 0) {
        log.debug({ removed, total, capBytes }, "clip cache trimmed");
    }

    return removed;
}

/** The words a target shows on screen, to find its frame: a term's heard and fixed words, a question's heard words. */
function hitWords(record: MeetingRecord, target: MomentTarget): string[] {
    if (target.kind !== "item") {
        return [];
    }

    const item = record.items.find((one) => one.id === questionIdOf(record, target.id));

    if (item?.kind === "term") {
        return [item.proposed, item.heard].filter((word): word is string => Boolean(word));
    }

    return item?.kind === "question" && item.heard ? [item.heard] : [];
}

/**
 * The frame on each display at `atSec`; none without a screen recording at that time. With `words`, the frame whose
 * OCR text shows one of them comes first and carries the block it shows it in (G-SCR-1, G-SCR-4). Never throws.
 */
export async function momentFrames(
    store: MeetingStore,
    record: MeetingRecord,
    atSec: number,
    words: string[] = []
): Promise<MomentFrame[]> {
    const folder = store.folder(record.id);

    // Frames the OCR worker has not read yet still show: a Moment shows the picture, the text only finds the word.
    if (!hasFrameIndex(folder)) {
        return [];
    }

    try {
        // Loaded here: listen asks for Moments without a screen and should not load the OCR readers.
        const { meetingScreen, readOcrRows } = await import("./screen-boxes");
        const { foldText } = await import("@genesiscz/utils/macos/ocr-boxes");
        const screen = await meetingScreen({ store, record, atSec, windowSec: 0 });
        const frames: MomentFrame[] = screen.displays.flatMap((display) => {
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
        const wanted = words.map(foldText).filter(Boolean);

        if (wanted.length === 0 || frames.length === 0) {
            return frames;
        }

        const files = new Set(frames.map((frame) => frame.file));
        const ocrPath = join(folder, "ocr.jsonl");
        const rows = existsSync(ocrPath) ? readOcrRows(ocrPath).filter((row) => files.has(row.file)) : [];
        const hits = frames.map((frame) => {
            const block = rows
                .find((row) => row.file === frame.file)
                ?.blocks.find((one) => wanted.some((word) => foldText(one.text).includes(word)));
            return block
                ? {
                      ...frame,
                      hit: {
                          text: block.text,
                          box: {
                              x: Number(block.bounds.x),
                              y: Number(block.bounds.y),
                              width: Number(block.bounds.width),
                              height: Number(block.bounds.height),
                          },
                      },
                  }
                : frame;
        });
        return [...hits.filter((frame) => frame.hit), ...hits.filter((frame) => !frame.hit)];
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
    padAfterSec?: number;
    /**
     * This tone instead of the settings' `playback.listen.tone.sound` (`play --tone`). It sounds for this call even
     * when `playback.listen.tone.enabled` is off: the caller asked for it.
     */
    toneSound?: ToneSoundSetting;
    /** Overrides whether this call has a tone. False wins over an explicit sound without changing saved settings. */
    tone?: boolean;
    /** Reads a tone file's length (tests pass a fake); ffprobe by default. */
    probeTone?: (path: string) => Promise<{ durationSec: number }>;
    /** At most this long from the span's start (`MomentInput.lengthSec`). */
    lengthSec?: number;
    screen?: boolean;
    /** The meeting already opened by the caller (a service that holds it, a test with its own source). */
    opened?: OpenedMeeting;
}

async function momentIn(opened: OpenedMeeting, options: OpenMomentOptions): Promise<Moment> {
    const { store, record } = options;
    const [meeting, config] = await Promise.all([opened.meeting(), opened.config()]);
    const saved = config.global.playback.listen;
    // An explicit sound enables this call unless the caller explicitly asks for silence. Never mutate the config.
    const enabled = options.tone ?? (options.toneSound !== undefined || saved.tone.enabled);
    const listen = enabled === saved.tone.enabled ? saved : { ...saved, tone: { ...saved.tone, enabled } };
    const toneSound = listen.tone.enabled
        ? await resolveToneSound(options.toneSound ?? listen.tone.sound, {
              probe: options.probeTone ?? probeAudio,
              onMissing: listen.tone.onMissing,
          })
        : undefined;
    const moment = planMoment({
        record,
        transcript: meeting.transcript,
        listen,
        target: options.target,
        ...(toneSound ? { toneSound } : {}),
        ...(options.padSec === undefined ? {} : { padSec: options.padSec }),
        ...(options.padAfterSec === undefined ? {} : { padAfterSec: options.padAfterSec }),
        ...(options.lengthSec === undefined ? {} : { lengthSec: options.lengthSec }),
    });

    if (options.screen === false) {
        return moment;
    }

    const screen = await momentFrames(store, record, moment.spotSec, hitWords(record, options.target));
    return screen.length > 0 ? { ...moment, screen } : moment;
}

/**
 * A Moment cut to its WAV in the clip cache (`momentCachePath`): what `play --clip` prints and the window plays. A
 * clip cut before for the same recording is used again (its time is touched, so the cache keeps it longest). A
 * recording with several audio streams is mixed (`probe`); `control` reports the cut's progress and cancels it.
 */
export async function clipMoment(
    options: OpenMomentOptions & {
        cut?: typeof cutClip;
        control?: Pick<CutControl, "signal" | "onProgress">;
        /** The recording's audio streams; ffprobe reads them when absent. */
        probe?: (path: string, options?: { signal?: AbortSignal }) => Promise<{ tracks: number }>;
    }
): Promise<Moment & { path: string }> {
    const { store, record } = options;
    options.control?.signal?.throwIfAborted();
    const opened = options.opened ?? OpenedMeeting.of(store, record);
    let moment = await momentIn(opened, options);
    const audioPath = await opened.audioPath();
    const itemId = options.target.kind === "item" ? questionIdOf(record, options.target.id) : undefined;
    const item = record.items.find((one) => one.id === itemId);
    if (item?.kind === "question" && item.question.startsWith('Who says "')) {
        const { refineSplitClip, questionClip } = await import("./listen-clips");
        const refined = await refineSplitClip({
            plan: questionClip({
                record,
                question: item,
                transcript: (await opened.meeting()).transcript,
                listen: (await opened.config()).global.playback.listen,
                pads: { beforeSec: moment.padSec, afterSec: moment.padAfterSec ?? moment.padSec },
                ...(moment.tone ? { toneSound: moment.tone.sound } : {}),
            }),
            question: item,
            audioPath,
        });
        moment = {
            ...moment,
            fromSec: refined.fromSec,
            toSec: refined.toSec,
            padSec: refined.padSec,
            startSec: Math.max(0, refined.fromSec - refined.padSec),
            endSec: refined.toSec + (refined.padAfterSec ?? refined.padSec),
        };
    }
    const stat = statSync(audioPath);
    const path = momentCachePath(moment, { path: audioPath, mtimeMs: stat.mtimeMs, size: stat.size });

    if (existsSync(path)) {
        const now = new Date();
        utimesSync(path, now, now);
        log.debug({ path }, "moment clip from the cache");
        return { ...moment, path };
    }

    // Cut beside the clip and rename it over the clip: a player that reads the clip (the window, a second play) never
    // gets it half written, and two cuts of one Moment at once each publish a whole file.
    const partial = join(dirname(path), `.${basename(path, ".wav")}-${randomUUID()}.wav`);
    mkdirSync(dirname(path), { recursive: true });

    try {
        const { tracks } = await (options.probe ?? probeAudio)(audioPath, { signal: options.control?.signal }).catch(
            (error: unknown) => {
                options.control?.signal?.throwIfAborted();
                log.debug({ error, audioPath }, "the recording's tracks do not read; it is cut as one track");
                return { tracks: 1 };
            }
        );
        await (options.cut ?? cutClip)({
            audioPath,
            outPath: partial,
            ...clipPlan(moment),
            tracks,
            ...(options.control?.signal ? { signal: options.control.signal } : {}),
            ...(options.control?.onProgress ? { onProgress: options.control.onProgress } : {}),
        });
        renameSync(partial, path);
    } catch (error) {
        removePartialClip(partial);
        throw error;
    }

    trimMomentCache();
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
