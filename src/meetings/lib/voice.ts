import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { microphoneCandidates } from "@genesiscz/utils/meetings/room-people";
import { clusterVoices, type LineVoice, lineVoices, voiceFrames } from "@genesiscz/utils/meetings/voice-features";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import type { OpenedMeeting } from "./opened-meeting";

/** Audio and confirmed speaker anchors, with physical channels preserved (0 left, 1 right). */
export async function meetingVoices(options: {
    opened: OpenedMeeting;
    voices?: number;
    channel?: number;
    /** Decodes the recording's voice frames (tests pass a table); ffmpeg by default. */
    frames?: typeof voiceFrames;
}): Promise<LineVoice[]> {
    const meeting = await options.opened.meeting();
    const lines = lineEvidence(meeting.transcript, { segments: [], speaking: [] });
    const spans = lines.map((line) => ({ index: line.index, fromSec: line.startSec, toSec: line.endSec }));
    const frames = await (options.frames ?? voiceFrames)({ audioPath: await options.opened.audioPath() });
    const measured = lineVoices({ frames, spans });
    if (options.voices === undefined) {
        return measured;
    }
    const calibration = (await options.opened.energy()).calibration;
    const micChannel = calibration?.layout === "right-mic" ? 1 : 0;
    return anchoredMeetingVoices({
        record: options.opened.record,
        transcript: meeting.transcript,
        features: measured,
        voices: options.voices,
        channel: options.channel ?? micChannel,
        micChannel,
    });
}

/** Reuse measured features when a caller changes the requested voice count or confirms a speaker anchor. */
export function anchoredMeetingVoices(options: {
    record: MeetingRecord;
    transcript: TranscriptEntry[];
    features: LineVoice[];
    voices: number;
    channel: number;
    micChannel: number;
}): LineVoice[] {
    const { record, channel, micChannel } = options;
    const lines = lineEvidence(options.transcript, { segments: [], speaking: [] });
    const allowed = record.seats
        ? channel === micChannel
            ? record.seats.room
            : record.seats.remote.map((person) => person.name)
        : undefined;
    const anchors = new Map<number, string>();
    const levels = new Map(options.features.map((feature) => [feature.index, feature.channels]));
    for (const line of lines) {
        // A confirmed speaker owns the line, not this channel's audio of it: a line louder on the other channel is
        // that channel's voice leaking in (or room speech under the call), so it anchors nothing here.
        const level = levels.get(line.index);
        if ((level?.[channel]?.rms ?? 0) < (level?.[1 - channel]?.rms ?? 0)) {
            continue;
        }
        const assignments =
            record.speakers.assignments?.filter(
                (item) =>
                    line.startSec >= item.fromSec &&
                    line.startSec <= item.toSec &&
                    (!item.label || sameName(item.label, line.label))
            ) ?? [];
        const confirmed = record.items.filter(
            (item) =>
                item.kind === "speaker-range" &&
                item.status === "confirmed" &&
                item.speaker &&
                line.startSec >= item.fromSec &&
                line.startSec <= item.toSec &&
                sameName(item.label, line.label)
        );
        const names = new Set([
            ...assignments.map((item) => item.person),
            ...confirmed.flatMap((item) => (item.kind === "speaker-range" && item.speaker ? [item.speaker] : [])),
        ]);
        const speaker = names.size === 1 ? [...names][0] : undefined;
        if (speaker && (!allowed || allowed.some((name) => sameName(name, speaker)))) {
            anchors.set(line.index, speaker);
        }
    }
    return clusterVoices({ lines: options.features, voices: options.voices, channel, anchors });
}

export function lineDeviceCandidates(options: {
    record: MeetingRecord;
    atSec: number;
    micShare?: number;
    liveName?: string;
}): string[] {
    return microphoneCandidates(
        options.record,
        options.atSec,
        (options.micShare ?? 0) >= 0.65 ? "self" : (options.liveName ?? "")
    );
}
