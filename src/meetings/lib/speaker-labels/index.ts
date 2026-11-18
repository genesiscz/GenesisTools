import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { profiler } from "@genesiscz/utils/profile";
import { lineChannelShares } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { OpenedMeeting } from "../opened-meeting";
import type { LabelContext, LineLabel, SpeakerLabeler, SpeakerLabelerId } from "./types";
import { SPEAKER_LABELER_IDS } from "./types";

const prof = profiler.scope("meetings-suggest");

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
    settings: MeetingsConfig["global"]["speakerLabels"],
    storedPresence?: Presence[],
    options: { voiceOnly?: boolean; applyAbove?: number } = {}
): Promise<LineLabel[]> {
    const enabled = SPEAKER_LABELER_IDS.filter((id) => settings[id].enabled);

    if (enabled.length === 0) {
        return [];
    }

    const meeting = await opened.meeting();
    const evidence = await prof.measureAsync("speakers.evidence", () => opened.evidence());
    const energy = await prof.measureAsync("speakers.energy", () => opened.energy());
    const record = opened.record;
    const presence = storedPresence ?? (await prof.measureAsync("speakers.presence", () => opened.presence()));
    // A named room seat can be the only attendance evidence for someone sharing another person's device.
    const stays = [...(presence ?? [])];
    const seated = [
        ...(record.seats?.room.map((name) => ({ name, fromSec: 0, toSec: Infinity })) ?? []),
        ...(record.seats?.remote ?? []),
    ];
    for (const seat of seated) {
        if (
            !stays.some((stay) => sameName(stay.name, seat.name)) &&
            !record.participants.some((p) => sameName(p.name, seat.name) && p.stays?.length === 0)
        ) {
            stays.push({ name: seat.name, fromSec: seat.fromSec ?? 0, toSec: seat.toSec ?? Infinity });
        }
    }
    const context: LabelContext = {
        lines: prof.measure("speakers.line-evidence", () =>
            lineChannelShares({
                entries: meeting.transcript,
                segments: evidence?.segments ?? [],
                energy: energy.share,
            }).flatMap(({ index, fromSec, toSec, share }): LabelContext["lines"][number][] => {
                // A missing channel or an exact tie establishes neither seat.
                if (share === undefined || share === 0.5) {
                    return [];
                }

                return [
                    {
                        index,
                        fromSec,
                        toSec,
                        seat: share > 0.5 ? "mic" : "call",
                    },
                ];
            })
        ),
        attended: stays.flatMap((stay): LabelContext["attended"][number][] => {
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
        project: record.project,
    };
    const byLabeler = new Map<SpeakerLabelerId, LineLabel[]>();

    for (const id of enabled) {
        using _labeler = prof.section(`speakers.labeler.${id}`);
        if (id === "voice" && context.project && context.attended.some((stay) => stay.seat)) {
            const { meetingVoiceSeeds } = await import("./voice-seeds");
            context.applyAbove = options.applyAbove ?? (await opened.config()).global.suggest.applyAbove;
            Object.assign(
                context,
                meetingVoiceSeeds({
                    opened,
                    meeting,
                    evidence,
                    energy: energy.share,
                    presence,
                    context,
                    seats: byLabeler.get("seat") ?? [],
                    applyAbove: context.applyAbove,
                })
            );
        }
        byLabeler.set(id, await (await LABELERS[id](opened, settings)).propose(context));
    }

    return options.voiceOnly ? (byLabeler.get("voice") ?? []) : mergeLineLabels(byLabeler);
}
