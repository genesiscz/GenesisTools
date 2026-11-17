import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toFloat32AudioWindow } from "@genesiscz/utils/audio/converter";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { ChannelLayout } from "@genesiscz/utils/meetings/energy";
import type { MeetingSourceId } from "@genesiscz/utils/meetings/sources";
import { AUDIO_SOURCES, type AudioSource } from "@genesiscz/utils/screen-recorder/control";
import { z } from "zod";
import { probeAudio } from "./audio";
import { CallTimeline } from "./call-timeline";
import type { OpenedMeeting } from "./opened-meeting";
import { ALIGN_SEARCH_SEC, alignPiece, alignReferenceFromSec } from "./sound-align";
import { isMeetingSourceId } from "./sources";

const { log } = logger.scoped("meetings-sound");

/**
 * The sound of one meeting: the source's own recording (its two channels) and the tracks the Meetings recorder kept
 * (`<meeting>/audio/`, listed in `audio.jsonl`). This is the one module that knows pieces, clocks, channels and which
 * track is best for a seat.
 */

export const AUDIO_FOLDER = "audio";
export const AUDIO_INDEX = "audio.jsonl";
/** The measured clock of the recorder tracks, beside the other derived evidence of the meeting. */
export const SOUND_CLOCK_FILE = join("evidence", "sound-clock.json");

export const TRACK_KINDS = ["source-mic", "source-call", "mic-raw", "system"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];
export type Seat = "mic" | "call";
export type SoundPurpose = "listen" | "voice";

/** How a row of `audio.jsonl` came to be: absent or `normal` is a track the capture handed over. */
export const AUDIO_ROW_KEPT = ["normal", "salvaged"] as const;

/** A row of `<meeting>/audio.jsonl`. Rows from before `zeroAt` and `kept` stay valid. */
export const audioRowSchema = z.object({
    /** The file, relative to the meeting folder (`audio/<frame name>-<source>.m4a`). */
    file: z.string(),
    source: z.enum(AUDIO_SOURCES),
    /** The capture's first frame on the wall clock. */
    at: z.string(),
    durationMs: z.number().default(0),
    mutedSpans: z.array(z.tuple([z.number(), z.number()])).default([]),
    /** Wall time of the file's second 0 (`at` + the engine's `startOffsetMs`). Absent: readers use `at`. */
    zeroAt: z.string().optional(),
    /** `salvaged`: the file was found in `.piece/` at a start or after the loop; its times come from the file. */
    kept: z.enum(AUDIO_ROW_KEPT).optional(),
});
export type AudioRow = z.infer<typeof audioRowSchema>;

/** The wall time of a row's second 0. */
export function audioRowZeroMs(row: AudioRow): number {
    return Date.parse(row.zeroAt ?? row.at);
}

/** The rows of a meeting's `audio.jsonl`; a malformed row is skipped with a warning. */
export function readAudioRows(folder: string): AudioRow[] {
    const index = join(folder, AUDIO_INDEX);

    if (!existsSync(index)) {
        return [];
    }

    return readFileSync(index, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
            try {
                const row = audioRowSchema.safeParse(SafeJSON.parse(line, { strict: true }));

                if (row.success) {
                    return [row.data];
                }

                log.warn({ index, issues: row.error.issues.length }, "skipping an audio row of an unknown shape");
                return [];
            } catch (err) {
                log.warn({ err, index }, "skipping a malformed audio row");
                return [];
            }
        });
}

export function appendAudioRow(folder: string, row: AudioRow): void {
    appendFileSync(join(folder, AUDIO_INDEX), `${SafeJSON.stringify(row)}\n`);
}

export interface SoundPiece {
    path: string;
    channel?: 0 | 1;
    /** The piece's second 0 on the transcript clock. */
    zeroSec: number;
    durationSec: number;
}

export interface SoundTrack {
    kind: TrackKind;
    seat: Seat;
    processing: "processed" | "raw" | "unknown";
    from: { kind: "source"; source: MeetingSourceId } | { kind: "recorder" };
    /** zeroSec is on the transcript clock. */
    pieces: SoundPiece[];
    /** `source`: the source's own clock; `measured`: matched to the source's sound; `stamp`: the wall-clock stamps. */
    clock: "source" | "measured" | "stamp";
}

export interface SoundSlice {
    track: TrackKind;
    path: string;
    channel?: 0 | 1;
    fileFromSec: number;
    fileToSec: number;
    clock: SoundTrack["clock"];
}

export interface SliceRequest {
    seat: Seat;
    fromSec: number;
    toSec: number;
    purpose: SoundPurpose;
    /** This track only, whatever the order of preference says. */
    track?: TrackKind;
}

export interface MeetingSound {
    readonly tracks: readonly SoundTrack[];
    /** The best track of the seat for the purpose that covers the span; undefined when none covers it. */
    slice(request: SliceRequest): SoundSlice | undefined;
}

/** Which track kind a recorder source makes. */
const RECORDER_KIND: Record<AudioSource, TrackKind> = { mic: "mic-raw", system: "system" };
const SEAT_OF: Record<TrackKind, Seat> = {
    "source-mic": "mic",
    "mic-raw": "mic",
    "source-call": "call",
    system: "call",
};
const FROM_RECORDER: Record<TrackKind, boolean> = {
    "source-mic": false,
    "source-call": false,
    "mic-raw": true,
    system: true,
};

/**
 * The order of tracks per purpose and seat. The voice purpose takes a recorder track only when its clock is
 * `measured` (a voice sample cut on a stamp can hold the neighbour's words).
 */
export const PREFERENCE: Record<SoundPurpose, Record<Seat, readonly TrackKind[]>> = {
    listen: { mic: ["mic-raw", "source-mic"], call: ["source-call", "system"] },
    voice: { mic: ["mic-raw", "source-mic"], call: ["source-call", "system"] },
};

/** The measured clock of the recorder tracks: per recorder source, the shift from the stamp to the source's clock. */
export const soundClockSchema = z.object({
    version: z.literal(1),
    sources: z.partialRecord(
        z.enum(AUDIO_SOURCES),
        z.object({
            /** Seconds to add to a piece's stamped second 0. */
            correctionSec: z.number(),
            /** Pieces measured, and how many of them had a clear peak. */
            pieces: z.number(),
            clear: z.number(),
        })
    ),
});
export type SoundClock = z.infer<typeof soundClockSchema>;

export interface SoundInputs {
    /** The meeting folder (the `audio.jsonl` rows name files relative to it). */
    folder: string;
    /** The wall time of transcript second 0. */
    timelineZeroMs: number;
    rows: readonly AudioRow[];
    /** The source's recording: its file, its id, which channel is the microphone, its length. */
    source?: { path: string; source: MeetingSourceId; layout: ChannelLayout; durationSec: number };
    clock?: SoundClock;
    /** `source`: the recorder tracks are never chosen by preference (an explicit `track` still is). */
    tracks: MeetingsConfig["global"]["playback"]["tracks"];
}

/** The source channel of each seat; an unknown layout leaves the call on the right channel, as suggest does. */
function sourceChannels(layout: ChannelLayout): Record<Seat, 0 | 1> {
    return layout === "right-mic" ? { mic: 1, call: 0 } : { mic: 0, call: 1 };
}

/** The recorder tracks per source, each piece on the transcript clock, corrected when its source was measured. */
function recorderTracks(inputs: SoundInputs): SoundTrack[] {
    return AUDIO_SOURCES.flatMap((source): SoundTrack[] => {
        const rows = inputs.rows.filter((row) => row.source === source);

        if (rows.length === 0) {
            return [];
        }

        const measured = inputs.clock?.sources[source];
        const correction = measured && measured.clear > 0 ? measured.correctionSec : undefined;
        const kind = RECORDER_KIND[source];
        const pieces = rows
            .map((row) => ({
                path: join(inputs.folder, row.file),
                zeroSec: (audioRowZeroMs(row) - inputs.timelineZeroMs) / 1000 + (correction ?? 0),
                durationSec: row.durationMs / 1000,
            }))
            .sort((a, b) => a.zeroSec - b.zeroSec);
        return [
            {
                kind,
                seat: SEAT_OF[kind],
                // The engine sets no voice processing; whether the microphone is raw is what sound-probe measures.
                processing: source === "system" ? "raw" : "unknown",
                from: { kind: "recorder" },
                pieces,
                clock: correction === undefined ? "stamp" : "measured",
            },
        ];
    });
}

function sourceTracks(source: NonNullable<SoundInputs["source"]>): SoundTrack[] {
    const channels = sourceChannels(source.layout);
    return (["source-mic", "source-call"] as const).map((kind) => ({
        kind,
        seat: SEAT_OF[kind],
        processing: "unknown",
        from: { kind: "source", source: source.source },
        pieces: [{ path: source.path, channel: channels[SEAT_OF[kind]], zeroSec: 0, durationSec: source.durationSec }],
        clock: "source",
    }));
}

/** The meeting's sound from what was read: the source's two channels first, then the recorder's tracks. */
export function meetingSound(inputs: SoundInputs): MeetingSound {
    const tracks: readonly SoundTrack[] = [
        ...(inputs.source ? sourceTracks(inputs.source) : []),
        ...recorderTracks(inputs),
    ];

    return {
        tracks,
        slice(request) {
            if (request.toSec <= request.fromSec) {
                return undefined;
            }

            const order = request.track
                ? [request.track]
                : PREFERENCE[request.purpose][request.seat].filter(
                      (kind) => inputs.tracks === "best" || !FROM_RECORDER[kind]
                  );

            for (const kind of order) {
                const track = tracks.find((one) => one.kind === kind && one.seat === request.seat);

                if (!track) {
                    continue;
                }

                if (request.purpose === "voice" && track.from.kind === "recorder" && track.clock !== "measured") {
                    continue;
                }

                const piece = track.pieces.find(
                    (one) => one.zeroSec <= request.fromSec && request.toSec <= one.zeroSec + one.durationSec
                );

                if (piece) {
                    return {
                        track: kind,
                        path: piece.path,
                        ...(piece.channel !== undefined ? { channel: piece.channel } : {}),
                        fileFromSec: request.fromSec - piece.zeroSec,
                        fileToSec: request.toSec - piece.zeroSec,
                        clock: track.clock,
                    };
                }
            }

            return undefined;
        },
    };
}

export function readSoundClock(folder: string): SoundClock | undefined {
    const path = join(folder, SOUND_CLOCK_FILE);

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = soundClockSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        return parsed.success ? parsed.data : undefined;
    } catch (err) {
        log.warn({ err, path }, "the measured sound clock could not be read; the stamps are used");
        return undefined;
    }
}

export function saveSoundClock(folder: string, clock: SoundClock): void {
    const path = join(folder, SOUND_CLOCK_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${SafeJSON.stringify(clock, null, 2)}\n`);
}

/** The transcript timeline: the source's when the record has one and it answers, else the stored clock. */
async function soundTimeline(opened: OpenedMeeting): Promise<CallTimeline> {
    if (!opened.sourceRef) {
        return CallTimeline.stored(opened.record);
    }

    try {
        return await opened.timeline();
    } catch (err) {
        log.warn({ err, meeting: opened.record.id }, "the source's clock is unavailable; the stored clock is used");
        return CallTimeline.stored(opened.record);
    }
}

async function soundSource(opened: OpenedMeeting): Promise<SoundInputs["source"]> {
    const ref = opened.sourceRef;

    if (!ref || !isMeetingSourceId(ref.sourceId)) {
        return undefined;
    }

    let path: string;

    try {
        path = await opened.audioPath();
    } catch (err) {
        log.debug({ err, meeting: opened.record.id }, "the source keeps no sound for this meeting");
        return undefined;
    }

    let durationSec = Number.POSITIVE_INFINITY;

    try {
        durationSec = (await probeAudio(path)).durationSec;
    } catch (err) {
        log.debug({ err, path }, "the source sound's length is unknown; it counts as covering every span");
    }

    return {
        path,
        source: ref.sourceId,
        layout: opened.record.evidence?.channels?.layout ?? "unknown",
        durationSec,
    };
}

/** Everything `meetingSound` needs, read from the meeting's folder, its source and the settings. */
export async function readSoundInputs(opened: OpenedMeeting): Promise<SoundInputs> {
    const folder = opened.store.folder(opened.record.id);
    const [timeline, source, config] = await Promise.all([soundTimeline(opened), soundSource(opened), opened.config()]);
    const clock = readSoundClock(folder);
    return {
        folder,
        timelineZeroMs: timeline.zeroMs,
        rows: readAudioRows(folder),
        ...(source ? { source } : {}),
        ...(clock ? { clock } : {}),
        tracks: config.global.playback.tracks,
    };
}

/** The meeting's sound; `OpenedMeeting.sound()` memoises it. */
export async function loadMeetingSound(opened: OpenedMeeting): Promise<MeetingSound> {
    return meetingSound(await readSoundInputs(opened));
}

/** One recorder piece measured against the source: the stamp, the measured second 0 and whether the peak was clear. */
export interface PieceClock {
    source: AudioSource;
    file: string;
    stampSec: number;
    zeroSec: number;
    clear: boolean;
}

/** Decoded at this rate: the envelope needs no more. */
const ALIGN_RATE = 16_000;

/**
 * Measures up to `maxPieces` recorder pieces per source (spread over the meeting) against the source channel of the
 * same seat. Reads only; `saveSoundClock` keeps the result. Undefined without source sound or ffmpeg.
 */
export async function measureSoundClock(
    inputs: SoundInputs,
    options: { maxPieces?: number; signal?: AbortSignal } = {}
): Promise<{ clock: SoundClock; pieces: PieceClock[] } | undefined> {
    const source = inputs.source;

    if (!source) {
        return undefined;
    }

    const channels = sourceChannels(source.layout);
    const seatOf: Record<AudioSource, Seat> = { mic: "mic", system: "call" };
    const maxPieces = options.maxPieces ?? 6;
    const measured: PieceClock[] = [];
    const clock: SoundClock = { version: 1, sources: {} };

    for (const recorderSource of AUDIO_SOURCES) {
        const rows = inputs.rows.filter((row) => row.source === recorderSource && row.durationMs > 0);
        const step = Math.max(1, Math.ceil(rows.length / maxPieces));
        const chosen = rows.filter((_row, index) => index % step === 0).slice(0, maxPieces);
        const corrections: number[] = [];

        for (const row of chosen) {
            const stampSec = (audioRowZeroMs(row) - inputs.timelineZeroMs) / 1000;
            const pieceSec = Math.min(row.durationMs / 1000, 60 - 2 * ALIGN_SEARCH_SEC);
            const fromSec = alignReferenceFromSec(stampSec);

            if (stampSec + pieceSec <= 0) {
                continue;
            }

            try {
                const [piece, reference] = await Promise.all([
                    toFloat32AudioWindow(join(inputs.folder, row.file), {
                        fromSec: 0,
                        toSec: pieceSec,
                        signal: options.signal,
                    }),
                    toFloat32AudioWindow(source.path, {
                        fromSec,
                        toSec: stampSec + pieceSec + ALIGN_SEARCH_SEC,
                        channel: channels[seatOf[recorderSource]],
                        signal: options.signal,
                    }),
                ]);
                const aligned = alignPiece({ piece, reference, rate: ALIGN_RATE, stampSec });
                measured.push({ source: recorderSource, file: row.file, stampSec, ...aligned });

                if (aligned.clear) {
                    corrections.push(aligned.zeroSec - stampSec);
                }
            } catch (err) {
                log.warn({ err, file: row.file }, "a recorder piece could not be measured");
            }
        }

        if (chosen.length > 0) {
            const sorted = corrections.toSorted((a, b) => a - b);
            clock.sources[recorderSource] = {
                correctionSec: sorted[Math.floor(sorted.length / 2)] ?? 0,
                pieces: chosen.length,
                clear: corrections.length,
            };
        }
    }

    return { clock, pieces: measured };
}
