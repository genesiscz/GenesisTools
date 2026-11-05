import { makeProxy, type ProxyOptions, type ProxyResult } from "@app/recorder/lib/proxy";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { transcriptCachePath } from "@genesiscz/utils/recording-editor/project";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { CallTimeline } from "./call-timeline";
import { OpenedMeeting } from "./opened-meeting";
import { writeMeetingRecordingManifest } from "./recording-manifest";
import { correctTranscript } from "./transcript-corrections";

const { log } = logger.scoped("meetings-editor-project");

/** A caption runs to the next line's start, but at most this long. */
const MAX_LINE_SEC = 12;

export interface CaptionSegment {
    /** `Speaker: text`, so every caption renderer shows the name. */
    text: string;
    /** Seconds on the movie's clock (the recording's start is 0). */
    start: number;
    end: number;
    speaker: string;
}

/**
 * The meeting transcript (speaker names applied) as caption segments on the recording's clock: a line said before the
 * recording started or after it ended is left out, and a line runs until the next one starts (at most 12 s).
 */
export function captionSegments(options: {
    entries: readonly TranscriptEntry[];
    /** Wall-clock ms of transcript second 0. */
    zeroMs: number;
    /** Wall-clock ms of the movie's second 0. */
    startedMs: number;
    durationSec: number;
}): CaptionSegment[] {
    const offsetSec = (options.zeroMs - options.startedMs) / 1000;
    const timed = options.entries.filter((entry) => entry.startSec !== undefined && entry.text.trim());
    const segments: CaptionSegment[] = [];

    for (const [index, entry] of timed.entries()) {
        const start = (entry.startSec ?? 0) + offsetSec;
        const next = timed[index + 1]?.startSec;
        const end = Math.min(start + MAX_LINE_SEC, next === undefined ? start + MAX_LINE_SEC : next + offsetSec);

        if (end <= 0 || start >= options.durationSec) {
            continue;
        }

        const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
        segments.push({
            text: `${entry.speaker}: ${entry.text.trim()}`,
            start: round(Math.max(0, start)),
            end: round(Math.min(options.durationSec, end)),
            speaker: entry.speaker,
        });
    }

    return segments;
}

export interface MeetingEditorSource {
    folder: string;
    proxy: ProxyResult;
    /** The transcript cache the editor reads beside the movie; absent when the meeting has no linked transcript. */
    transcript?: string;
    captions: number;
}

/**
 * Makes a meeting's screen recording an editor project: its `recording.json`, `proxy.mp4` (one display throughout,
 * or by default per window the display with the most change), and the transcript beside it as captions with the
 * speakers' names (`proxy.transcript.json`). The editor then opens the meeting folder like any recording.
 */
export async function meetingEditorSource(
    options: {
        store: MeetingStore;
        record: MeetingRecord;
    } & ProxyOptions
): Promise<MeetingEditorSource> {
    const { store, record } = options;
    const folder = store.folder(record.id);
    const manifest = readRecordingManifest(folder) ?? writeMeetingRecordingManifest(folder, record);

    if (!manifest) {
        throw new Error(`${record.id} has no screen recording (no frames)`);
    }

    const proxy = await makeProxy(folder, {
        ...(options.display !== undefined ? { display: options.display } : {}),
        ...(options.windowSec !== undefined ? { windowSec: options.windowSec } : {}),
        ...(options.overrides ? { overrides: options.overrides } : {}),
        ...(options.plan ? { plan: options.plan } : {}),
    });
    const lastMs = Math.max(0, ...manifest.frames.map((frame) => frame.atMs));
    const opened = OpenedMeeting.of(store, record);
    let entries: TranscriptEntry[];

    try {
        const meeting = await opened.meeting();
        const config = await new MeetingsConfigStore().read();
        entries = correctTranscript({ record, transcript: meeting.transcript, config, format: "json" }).entries;
    } catch (error) {
        log.info({ meeting: record.id, error }, "no linked transcript; the editor project has no captions");
        return { folder, proxy, captions: 0 };
    }

    const segments = captionSegments({
        entries,
        zeroMs: (await CallTimeline.forRecord(record)).zeroMs,
        startedMs: Date.parse(manifest.startedAt),
        durationSec: lastMs / 1000 + 1,
    });
    const transcript = transcriptCachePath(proxy.path);
    atomicWriteFileSync(
        transcript,
        SafeJSON.stringify({ text: segments.map((one) => one.text).join("\n"), segments, source: "meeting" }, null, 2)
    );
    log.info({ meeting: record.id, proxy: proxy.path, captions: segments.length }, "meeting editor project ready");
    return { folder, proxy, transcript, captions: segments.length };
}
