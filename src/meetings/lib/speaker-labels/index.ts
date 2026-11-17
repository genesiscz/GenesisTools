import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { OpenedMeeting } from "../opened-meeting";
import type { LabelContext, LineLabel, SpeakerLabeler, SpeakerLabelerId } from "./types";
import { SPEAKER_LABELER_IDS } from "./types";

// The synchronous rule lets the pure item writer use the same registry without loading a labeler's dependencies.
type LabelerLoader = ((
    opened: OpenedMeeting,
    settings: MeetingsConfig["global"]["speakerLabels"]
) => Promise<SpeakerLabeler>) &
    Pick<SpeakerLabeler, "rule">;
const LABELERS: Record<SpeakerLabelerId, LabelerLoader> = {
    seat: Object.assign(async () => (await import("./seat")).seatLabeler, { rule: MeetingRule.Attendance }),
    voice: Object.assign(
        async (opened: OpenedMeeting, settings: MeetingsConfig["global"]["speakerLabels"]) =>
            (await import("./voice")).voiceLabeler({ opened, settings: settings.voice }),
        { rule: MeetingRule.VoiceEmbedding }
    ),
};

export function speakerLabelRule(id: SpeakerLabelerId): MeetingRule {
    return LABELERS[id].rule;
}

/** Seat ownership wins; a stranger veto wins over ownership; otherwise a named proposal wins over a refusal. */
export function mergeLineLabels(byLabeler: ReadonlyMap<SpeakerLabelerId, LineLabel[]>): LineLabel[] {
    const byLine = new Map<number, LineLabel[]>();

    for (const labels of byLabeler.values()) {
        for (const label of labels) {
            const group = byLine.get(label.index) ?? [];
            group.push(label);
            byLine.set(label.index, group);
        }
    }

    return [...byLine]
        .sort(([a], [b]) => a - b)
        .map(
            ([, labels]) =>
                labels.find((label) => label.reason === "not-the-seat-person") ??
                labels.find((label) => label.reason === "seat-of-one" && label.person) ??
                labels.find((label) => label.person) ??
                labels[0]!
        );
}

export async function proposeSpeakerLabels(
    opened: OpenedMeeting,
    settings: MeetingsConfig["global"]["speakerLabels"]
): Promise<LineLabel[]> {
    const enabled = SPEAKER_LABELER_IDS.filter((id) => settings[id].enabled);

    if (enabled.length === 0) {
        return [];
    }

    const meeting = await opened.meeting();
    const evidence = await opened.evidence();
    const energy = await opened.energy();
    const record = opened.record;
    const context: LabelContext = {
        lines: lineEvidence(
            meeting.transcript,
            evidence ?? { segments: [], speaking: [] },
            undefined,
            energy.share
        ).flatMap((line): LabelContext["lines"][number][] => {
            const share = line.micShare ?? line.energyMic;

            // A missing channel or an exact tie establishes neither seat.
            if (share === undefined || share === 0.5) {
                return [];
            }

            return [
                {
                    index: line.index,
                    fromSec: line.startSec,
                    toSec: line.endSec,
                    seat: share > 0.5 ? "mic" : "call",
                },
            ];
        }),
        attended: ((await opened.presence()) ?? []).flatMap((stay): LabelContext["attended"][number][] => {
            if (record.seats?.room.some((person) => sameName(person, stay.name))) {
                return [{ person: stay.name, seat: "mic", fromSec: stay.fromSec, toSec: stay.toSec }];
            }

            const remote = record.seats?.remote.find((person) => sameName(person.name, stay.name));
            const self = record.participants.some((person) => person.self && sameName(person.name, stay.name));
            return [
                {
                    person: stay.name,
                    // Saved seats state who is in the room: the owner speaks into the microphone, everybody else
                    // attends through the call, so a person with no seat entry still shares the call seat.
                    seat: remote ? "call" : record.seats ? (self ? "mic" : "call") : undefined,
                    fromSec: Math.max(stay.fromSec, remote?.fromSec ?? stay.fromSec),
                    toSec: Math.min(stay.toSec, remote?.toSec ?? stay.toSec),
                },
            ];
        }),
        sound: await opened.sound(),
        project: record.project,
    };
    const byLabeler = new Map<SpeakerLabelerId, LineLabel[]>();

    for (const id of enabled) {
        byLabeler.set(id, await (await LABELERS[id](opened, settings)).propose(context));
    }

    return mergeLineLabels(byLabeler);
}
