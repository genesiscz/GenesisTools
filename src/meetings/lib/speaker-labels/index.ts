import { fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { seatSpan } from "@genesiscz/utils/meetings/seats";
import { profiler } from "@genesiscz/utils/profile";
import { lineChannelShares } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { OpenedMeeting } from "../opened-meeting";
import type { VoiceLine } from "../voice-names";
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

async function labelContext(opened: OpenedMeeting, storedPresence?: Presence[]) {
    const meeting = await opened.meeting();
    const evidence = await prof.measureAsync("speakers.evidence", () => opened.evidence());
    const energy = await prof.measureAsync("speakers.energy", () => opened.energy());
    const record = opened.record;
    const presence = storedPresence ?? (await prof.measureAsync("speakers.presence", () => opened.presence()));
    const attended: LabelContext["attended"][number][] = [];
    const ownMic = record.seats?.microphones?.find((group) => group.id === "self");
    for (const row of record.seats?.room ?? []) {
        const { name, fromSec = 0, toSec = Infinity } = seatSpan(row);
        if (!ownMic || ownMic.people.some((person) => sameName(person, name))) {
            attended.push({ person: name, seat: "mic", fromSec, toSec });
        }
    }
    for (const row of record.seats?.remote ?? []) {
        const { name, fromSec = 0, toSec = Infinity } = row;
        const calls = presence?.filter((stay) => sameName(stay.name, name)) ?? [];
        if (calls.length) {
            for (const call of calls) {
                const start = Math.max(fromSec, call.fromSec);
                const end = Math.min(toSec, call.toSec);
                if (start < end) {
                    attended.push({ person: name, seat: "call", fromSec: start, toSec: end });
                }
            }
        } else if (
            fromSec < toSec &&
            !record.participants.some((p) => sameName(p.name, name) && p.stays?.length === 0)
        ) {
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
        attended,
        project: record.project,
    };
    async function forVoice(seats: LineLabel[], applyAbove?: number): Promise<LabelContext> {
        if (!context.project || !context.attended.some((stay) => stay.seat)) {
            return context;
        }
        const threshold = applyAbove ?? (await opened.config()).global.suggest.applyAbove;
        const { meetingVoiceSeeds } = await import("./voice-seeds");
        const seeds = meetingVoiceSeeds({
            opened,
            meeting,
            evidence,
            energy: energy.share,
            presence,
            context,
            seats,
            applyAbove: threshold,
        });
        return { ...context, ...seeds, applyAbove: threshold };
    }
    return { context, forVoice };
}

export async function proposeSpeakerLabels(
    opened: OpenedMeeting,
    settings: MeetingsConfig["global"]["speakerLabels"],
    storedPresence?: Presence[],
    options: { voiceOnly?: boolean; applyAbove?: number } = {}
): Promise<LineLabel[]> {
    const enabled = SPEAKER_LABELER_IDS.filter((id) => settings[id].enabled);
    if (!enabled.length) {
        return [];
    }
    const { context, forVoice } = await labelContext(opened, storedPresence);
    const byLabeler = new Map<SpeakerLabelerId, LineLabel[]>();

    for (const id of enabled) {
        using _labeler = prof.section(`speakers.labeler.${id}`);
        const inputs = id === "voice" ? await forVoice(byLabeler.get("seat") ?? [], options.applyAbove) : context;
        byLabeler.set(id, await (await LABELERS[id](opened, settings)).propose(inputs));
    }

    return options.voiceOnly ? (byLabeler.get("voice") ?? []) : mergeLineLabels(byLabeler);
}

// Keep one meeting's embeddings while its editor is open. Track, clock, source identity or span changes invalidate it.
let lastEmbeddings: { key: string; lines: VoiceLine[] } | undefined;

async function previewVoiceLines(opened: OpenedMeeting, context: LabelContext, model: string, signal?: AbortSignal) {
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

export async function preparePreviewLabels(
    opened: OpenedMeeting,
    settings: MeetingsConfig["global"]["speakerLabels"],
    presence: Presence[] | undefined,
    signal?: AbortSignal
) {
    type VoiceSettings = typeof settings.voice;
    if (!settings.seat.enabled && !settings.voice.enabled) {
        return (_voice: VoiceSettings, _applyAbove: number): LineLabel[] => [];
    }
    const { context, forVoice } = await labelContext(opened, presence);
    const labels = new Map<SpeakerLabelerId, LineLabel[]>();
    if (settings.seat.enabled) {
        labels.set("seat", await (await LABELERS.seat(opened, settings)).propose(context));
    }
    if (!settings.voice.enabled || !context.project || !context.attended.some((stay) => stay.seat)) {
        const seats = mergeLineLabels(labels);
        return (_voice: VoiceSettings, _applyAbove: number) => seats;
    }
    const { voiceLabeler } = await import("./voice");
    let embeddings: { model: string; lines: Promise<VoiceLine[]> } | undefined;
    const previewLines = (inputs: LabelContext, model: string) => {
        if (embeddings?.model !== model) {
            embeddings = { model, lines: previewVoiceLines(opened, inputs, model, signal) };
        }
        return embeddings.lines;
    };
    return async (voice: VoiceSettings, applyAbove: number) => {
        const inputs = await forVoice(labels.get("seat") ?? [], applyAbove);
        labels.set("voice", await voiceLabeler({ opened, settings: voice, readLines: previewLines }).propose(inputs));
        return mergeLineLabels(labels);
    };
}
