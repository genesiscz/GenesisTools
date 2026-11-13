import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { microphoneCandidates } from "@genesiscz/utils/meetings/room-people";
import { clusterVoices, type LineVoice, lineVoices, voiceFrames } from "@genesiscz/utils/meetings/voice-features";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { OpenedMeeting } from "./opened-meeting";

/** Audio and confirmed speaker anchors, with physical channels preserved (0 left, 1 right). */
export async function meetingVoices(options: {
    opened: OpenedMeeting;
    voices?: number;
    channel?: number;
}): Promise<LineVoice[]> {
    const meeting = await options.opened.meeting();
    const lines = lineEvidence(meeting.transcript, { segments: [], speaking: [] });
    const spans = lines.map((line) => ({ index: line.index, fromSec: line.startSec, toSec: line.endSec }));
    const frames = await voiceFrames({ audioPath: await options.opened.audioPath() });
    const measured = lineVoices({ frames, spans });
    if (options.voices === undefined) {
        return measured;
    }
    const record = options.opened.record;
    const anchors = new Map<number, string>();
    for (const line of lines) {
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
        if (names.size === 1) {
            anchors.set(line.index, [...names][0]!);
        }
    }
    const calibration = (await options.opened.energy()).calibration;
    const channel = options.channel ?? (calibration?.layout === "right-mic" ? 1 : 0);
    return clusterVoices({ lines: measured, voices: options.voices, channel, anchors });
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
        (options.micShare ?? 0) >= 0.9 ? "self" : (options.liveName ?? "")
    );
}
