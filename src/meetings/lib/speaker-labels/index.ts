import { fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { AcousticShare } from "@genesiscz/utils/meetings/echo";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { seatSpan } from "@genesiscz/utils/meetings/seats";
import { readVoiceLibrary, type VoiceLibrarySnapshot } from "@genesiscz/utils/meetings/voice-library";
import { profiler } from "@genesiscz/utils/profile";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { OpenedMeeting } from "../opened-meeting";
import { LineSpeakers } from "../speaker-evidence";
import type { VoiceLine } from "../voice-names";
import { ENERGY_CALL_LEANS } from "./seat";
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

/**
 * Seat ownership wins; a stranger veto wins over ownership; otherwise a named proposal wins over a refusal. A seat
 * label keeps the voice's support for its own person, so the voice's agreement is not dropped with the voice label.
 */
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
        .map(([, labels]) => {
            const matched = labels.find(
                (label) => label.labeler === "voice" && label.reason === "named" && label.person
            );
            if (
                matched &&
                !labels.some(
                    (label) => label.reason === "seat-of-one" && label.person && sameName(label.person, matched.person!)
                )
            ) {
                return matched;
            }
            const veto = labels.find((label) => label.reason === "not-the-seat-person");
            if (veto) {
                return veto;
            }

            const owned = labels.find(
                (label): label is LineLabel & { person: string } => label.reason === "seat-of-one" && !!label.person
            );
            if (!owned) {
                return labels.find((label) => label.person) ?? labels[0]!;
            }

            const support =
                owned.voiceSupport ??
                labels.find((label) => label.voiceSupport && sameName(label.voiceSupport.person, owned.person))
                    ?.voiceSupport;
            return support ? { ...owned, voiceSupport: support } : owned;
        });
}

async function labelContext(
    opened: OpenedMeeting,
    voiceEnabled: boolean,
    storedPresence?: Presence[],
    measuredEnergy?: AcousticShare
) {
    const meeting = await opened.meeting();
    const evidence = await prof.measureAsync("speakers.evidence", () => opened.evidence());
    const energy = measuredEnergy ?? (await prof.measureAsync("speakers.energy", () => opened.energy())).share;
    const record = opened.record;
    const presence = storedPresence ?? (await prof.measureAsync("speakers.presence", () => opened.presence()));
    const attended: LabelContext["attended"][number][] = [];
    const ownMic = record.seats?.microphones?.find((group) => group.id === "self");
    for (const row of record.seats?.room ?? []) {
        const { name, fromSec = 0, toSec = Infinity } = seatSpan(row);
        if (
            record.seats?.microphones?.some(
                (group) =>
                    group.id !== "self" && group.deviceId && group.people.some((person) => sameName(person, name))
            )
        ) {
            attended.push({ person: name, seat: "call", fromSec, toSec });
        }
        if (!ownMic || ownMic.people.some((person) => sameName(person, name))) {
            attended.push({ person: name, seat: "mic", fromSec, toSec });
        }
    }
    for (const row of record.seats?.remote ?? []) {
        const { name, fromSec = 0, toSec = Infinity } = row;
        // A mapped input may transmit this occupant outside their personal call stay.
        // speakersFor intersects the appropriate account and the physical occupancy for each line.
        if (fromSec < toSec && !record.participants.some((p) => sameName(p.name, name) && p.stays?.length === 0)) {
            attended.push({ person: name, seat: "call", fromSec, toSec });
        }
    }
    // Only participants with no explicit seat inherit the old self/call fallback. Never fill a saved gap.
    for (const stay of presence ?? []) {
        if (
            record.seats?.room.some((row) => sameName(seatSpan(row).name, stay.name)) ||
            record.seats?.remote.some((row) => sameName(row.name, stay.name))
        ) {
            continue;
        }
        const self = record.participants.some((person) => person.self && sameName(person.name, stay.name));
        attended.push({
            person: stay.name,
            seat: record.seats ? (self ? "mic" : "call") : undefined,
            fromSec: stay.fromSec,
            toSec: stay.toSec,
        });
    }
    const measured = lineEvidence(
        meeting.transcript,
        evidence ?? { segments: [], speaking: [] },
        presence,
        voiceEnabled ? energy : energy && ((from, to) => energy(from, to) ?? energy.raw?.(from, to))
    );
    const speakers = new LineSpeakers({
        devices: opened.roomDevices,
        lines: measured,
        record,
        meeting,
        presence,
        selfName: record.participants.find((p) => p.self)?.name ?? evidence?.selfName,
    });
    const context: LabelContext = {
        lines: prof.measure("speakers.line-evidence", () =>
            measured.flatMap((line): LabelContext["lines"][number][] => {
                const { index, startSec: fromSec, endSec: toSec } = line;
                const energyMic = line.energyMic ?? line.energyMicRaw;
                const share = energyMic ?? line.micShare;
                const eligibility = speakers.eligibility.get(index)!;
                // A missing channel or an exact tie establishes neither seat.
                if (share === undefined || share === ENERGY_CALL_LEANS) {
                    return [];
                }

                return [
                    {
                        index,
                        fromSec,
                        toSec,
                        seat: share > ENERGY_CALL_LEANS ? "mic" : "call",
                        energyMic,
                        eligible: eligibility.channel.side === "mixed" ? [] : eligibility.choices,
                        rosterOnly:
                            eligibility.channel.side === "call" &&
                            eligibility.choices.length === 1 &&
                            (!record.seats?.remote.some((row) => sameName(row.name, eligibility.choices[0]!)) ||
                                eligibility.excluded.some((row) => row.reason.includes("muted"))),
                    },
                ];
            })
        ),
        attended: attended.filter((row) => !speakers.isRoomDevice(row.person)),
        project: record.project,
    };
    async function forVoice(seats: LineLabel[], applyAbove: number): Promise<LabelContext> {
        if (!context.project || !context.attended.some((stay) => stay.seat)) {
            return context;
        }
        const { meetingVoiceSeeds } = await import("./voice-seeds");
        const seeds = meetingVoiceSeeds({
            opened,
            meeting,
            evidence,
            energy,
            presence,
            context,
            seats,
            applyAbove,
            speakers,
            measured,
        });
        const seatOwners = new Map<number, string>();
        for (const label of seats) {
            if (label.reason === "seat-of-one" && label.person && !label.reviewOnly) {
                seatOwners.set(label.index, label.person);
            }
        }

        return { ...context, ...seeds, seatOwners, applyAbove };
    }
    return { context, forVoice };
}

export async function proposeSpeakerLabels(
    opened: OpenedMeeting,
    settings: MeetingsConfig["global"]["speakerLabels"],
    storedPresence?: Presence[],
    options: { voiceOnly?: boolean; applyAbove?: number; energyMicShare?: AcousticShare } = {}
): Promise<LineLabel[]> {
    const enabled = SPEAKER_LABELER_IDS.filter((id) => settings[id].enabled);
    if (!enabled.length) {
        return [];
    }
    const { context, forVoice } = await labelContext(
        opened,
        settings.voice.enabled,
        storedPresence,
        options.energyMicShare
    );
    const applyAbove = options.applyAbove ?? (await opened.config()).global.suggest.applyAbove;
    const byLabeler = new Map<SpeakerLabelerId, LineLabel[]>();

    for (const id of enabled) {
        using _labeler = prof.section(`speakers.labeler.${id}`);
        const inputs =
            id === "voice" ? await forVoice(byLabeler.get("seat") ?? [], applyAbove) : { ...context, applyAbove };
        byLabeler.set(id, await (await LABELERS[id](opened, settings)).propose(inputs));
    }

    return options.voiceOnly ? (byLabeler.get("voice") ?? []) : mergeLineLabels(byLabeler);
}

// Keep one meeting's embeddings while its editor is open. Track, clock, source identity or span changes invalidate it.
let lastEmbeddings: { key: string; lines: VoiceLine[] } | undefined;

async function previewVoiceLines(options: {
    opened: OpenedMeeting;
    context: LabelContext;
    model: string;
    signal?: AbortSignal;
}) {
    const { opened, context, model, signal } = options;
    const { voiceReadMeeting } = await import("../voices");
    const sound = await (await voiceReadMeeting(opened)).sound();
    const identities = new Map<string, ReturnType<typeof fileIdentity>>();
    const slices = context.lines.map((line) => {
        const slice = sound.slice({ ...line, purpose: "voice" });
        if (slice && !identities.has(slice.path)) {
            identities.set(slice.path, fileIdentity(slice.path));
        }
        return [line, slice];
    });
    const key = SafeJSON.stringify([opened.record.id, model, [...identities], slices]);
    let lines = lastEmbeddings?.key === key ? lastEmbeddings.lines : undefined;
    if (!lines) {
        const { embedSeatLines } = await import("./voice");
        // The empty path explicitly disables both persistent caches, including the default inferred from audio.
        lines = await embedSeatLines({
            lines: context.lines,
            sound,
            config: await opened.config(),
            cachePath: "",
            signal,
        });
        signal?.throwIfAborted();
        if (lines.every((line) => line.channels.every((channel) => channel.quality === "ready"))) {
            lastEmbeddings = { key, lines };
        }
    }
    return lines;
}

export async function preparePreviewLabels(options: {
    opened: OpenedMeeting;
    settings: MeetingsConfig["global"]["speakerLabels"];
    presence?: Presence[];
    signal?: AbortSignal;
    measuredEnergy?: AcousticShare;
    /** Both sides of one threshold preview score against the same voice library snapshot. */
    voiceLibrary?: () => VoiceLibrarySnapshot;
}) {
    const { opened, settings, presence, signal, measuredEnergy } = options;
    type VoiceSettings = typeof settings.voice;
    if (!settings.seat.enabled && !settings.voice.enabled) {
        return (_voice: VoiceSettings, _applyAbove: number): LineLabel[] => [];
    }
    const { context, forVoice } = await labelContext(opened, settings.voice.enabled, presence, measuredEnergy);
    const seat = settings.seat.enabled ? await LABELERS.seat(opened, settings) : undefined;
    const seatsAt = (applyAbove: number) => seat?.propose({ ...context, applyAbove }) ?? [];
    if (!settings.voice.enabled || !context.project || !context.attended.some((stay) => stay.seat)) {
        return (_voice: VoiceSettings, applyAbove: number) => seatsAt(applyAbove);
    }
    const { voiceLabeler } = await import("./voice");
    const voiceLibrary = (options.voiceLibrary ?? readVoiceLibrary)();
    let embeddings: { model: string; lines: Promise<VoiceLine[]> } | undefined;
    const previewLines = (inputs: LabelContext, model: string) => {
        if (embeddings?.model !== model) {
            embeddings = { model, lines: previewVoiceLines({ opened, context: inputs, model, signal }) };
        }
        return embeddings.lines;
    };
    return async (voice: VoiceSettings, applyAbove: number) => {
        const seats = await seatsAt(applyAbove);
        const inputs = await forVoice(seats, applyAbove);
        const voices = await voiceLabeler({ opened, settings: voice, readLines: previewLines, voiceLibrary }).propose(
            inputs
        );
        return mergeLineLabels(
            new Map([
                ["seat", seats],
                ["voice", voices],
            ])
        );
    };
}
