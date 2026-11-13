import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { type MeetingStore, nextId } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import {
    embedVoiceLines,
    type LineEmbedding,
    saveVoiceSample,
    scoreVoice,
    type VoiceMatch,
    type VoiceSample,
} from "@genesiscz/utils/meetings/voice";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import type { OpenedMeeting } from "./opened-meeting";

export async function enrolMeetingVoices(options: {
    opened: OpenedMeeting;
    store: MeetingStore;
}): Promise<{ samples: number; matched: number; unknown: number }> {
    const record = options.opened.record;
    const layout = (await options.opened.energy()).calibration?.layout;
    if (!layout || layout === "unknown") {
        throw new Error("Calibrate physical microphone/call channels before voice enrolment");
    }
    if (!record.seats?.remote.length) {
        throw new Error("Set remote seats before voice enrolment");
    }
    const callChannel = layout === "left-mic" ? 1 : 0;
    const transcript = (await options.opened.meeting()).transcript;
    const lines = lineEvidence(transcript, { segments: [], speaking: [] });
    const embeddings = await embedVoiceLines({
        audioPath: await options.opened.audioPath(),
        spans: lines.map((line) => ({ index: line.index, fromSec: line.startSec, toSec: line.endSec })),
        channels: [{ channel: callChannel, track: "isolated-call" }],
    });
    const end = Math.max(0, ...lines.map((line) => line.endSec));
    const remote = record.seats.remote.map((seat) => ({
        name: seat.name,
        fromSec: seat.fromSec ?? record.participants.find((person) => person.name === seat.name)?.firstSeenSec ?? 0,
        toSec: seat.toSec ?? end,
    }));
    const samples = enrolRemoteVoices({
        record,
        embeddings,
        remote,
        labels: new Map(lines.map((line) => [line.index, line.label])),
    });
    const matches = scoreRemoteLines({ embeddings, samples });
    const enrolment = join(options.store.folder(record.id), "voice-enrolment.json");
    // Preserve both unavailable reasons and exact source/channel provenance; failed extraction is not a zero vector.
    atomicWriteFileSync(join(options.store.folder(record.id), "voice-embeddings.json"), SafeJSON.stringify(embeddings));
    for (const sample of samples) {
        saveVoiceSample(enrolment, sample);
    }
    await options.store.update(record.id, { command: "listen", change: "enrol isolated-call voices" }, (current) => {
        current.evidence ??= {};
        current.evidence.voice = {
            version: 1,
            source: embeddings[0]?.channels[0]?.source.audioPath ?? "",
            enrolment,
            lines: Object.fromEntries(matches.map((line) => [String(line.index), line.match])),
        };
        for (const item of current.items) {
            if (
                item.kind !== "speaker-range" ||
                item.status !== "suggested" ||
                item.evidence?.decisionGate !== "cosine and margin"
            ) {
                continue;
            }
            const index = lines.find((line) => line.label === item.label && line.startSec === item.fromSec)?.index;
            const latest = matches.find((line) => line.index === index)?.match;
            if (latest?.quality !== "matched") {
                item.status = "rejected";
                item.evidence = {
                    ...item.evidence,
                    retired: "Latest canonical voice evidence is unknown",
                    ...(latest ? { voice: latest } : {}),
                };
            }
        }
        for (const { index, match } of matches) {
            const line = lines.find((one) => one.index === index);
            if (
                !line ||
                match.quality !== "matched" ||
                !match.person ||
                !remote.some(
                    (stay) => stay.name === match.person && line.startSec >= stay.fromSec && line.endSec <= stay.toSec
                )
            ) {
                continue;
            }
            const confirmed = current.items.some(
                (item) =>
                    item.kind === "speaker-range" &&
                    item.status === "confirmed" &&
                    item.label === line.label &&
                    line.startSec >= item.fromSec &&
                    line.startSec <= item.toSec
            );
            const existing = current.items.find(
                (item) =>
                    item.kind === "speaker-range" &&
                    item.status === "suggested" &&
                    item.label === line.label &&
                    item.fromSec === line.startSec &&
                    item.toSec === line.startSec &&
                    item.evidence?.decisionGate === "cosine and margin"
            );
            if (existing?.kind === "speaker-range") {
                existing.speaker = match.person;
                existing.rules = [...new Set([...existing.rules, MeetingRule.VoiceEmbedding])];
                existing.evidence = { ...existing.evidence, voice: match };
            } else if (!confirmed) {
                current.items.push({
                    kind: "speaker-range",
                    id: nextId("i", current.items),
                    label: line.label,
                    fromSec: line.startSec,
                    toSec: line.startSec,
                    speaker: match.person,
                    status: "suggested",
                    confidence: 0.8,
                    rules: [MeetingRule.VoiceEmbedding],
                    suggestedAt: new Date().toISOString(),
                    evidence: {
                        voice: match,
                        decisionGate: "cosine and margin",
                        confidenceMeaning: "rule gate passed; cosine is not probability",
                    },
                });
            }
        }
    });
    return {
        samples: samples.length,
        matched: matches.filter((line) => line.match.quality === "matched").length,
        unknown: embeddings.length - matches.filter((line) => line.match.quality === "matched").length,
    };
}

export interface RemoteStay {
    name: string;
    fromSec: number;
    toSec: number;
}

/** Enrol isolated call audio only when one remote person is possible, or a human confirmed the line. */
export function enrolRemoteVoices(options: {
    record: MeetingRecord;
    embeddings: readonly LineEmbedding[];
    remote: readonly RemoteStay[];
    labels?: ReadonlyMap<number, string>;
}): VoiceSample[] {
    const samples: VoiceSample[] = [];
    for (const line of options.embeddings) {
        for (const channel of line.channels) {
            if (channel.quality !== "ready" || channel.track !== "isolated-call") {
                continue;
            }
            const present = [
                ...new Set(
                    options.remote
                        .filter((stay) => stay.fromSec <= channel.fromSec && stay.toSec >= channel.toSec)
                        .map((stay) => stay.name)
                ),
            ];
            const confirmed = options.record.items
                .filter(
                    (item) =>
                        item.kind === "speaker-range" &&
                        item.status === "confirmed" &&
                        (!options.labels || item.label === options.labels.get(line.index)) &&
                        item.fromSec <= channel.fromSec &&
                        item.toSec >= channel.fromSec
                )
                .flatMap((item) =>
                    item.kind === "speaker-range" && item.speaker && !item.voices ? [item.speaker] : []
                );
            const names = [...new Set(confirmed)].filter((name) => present.includes(name));
            const person =
                names.length === 1 ? names[0] : names.length === 0 && present.length === 1 ? present[0] : undefined;
            if (person) {
                samples.push({
                    person,
                    model: channel.model,
                    source: channel.source.audioPath,
                    channel: channel.channel,
                    fromSec: channel.fromSec,
                    toSec: channel.toSec,
                    embedding: channel.embedding,
                    confirmed: true,
                });
            }
        }
    }
    return samples;
}

/** Leave-one-window-out scoring prevents enrolment from proving its own label. Cosine is not a probability. */
export function scoreRemoteLines(options: {
    embeddings: readonly LineEmbedding[];
    samples: readonly VoiceSample[];
    threshold?: number;
    margin?: number;
}): Array<{ index: number; match: VoiceMatch }> {
    return options.embeddings.flatMap((line) =>
        line.channels.flatMap((channel) => {
            if (channel.track !== "isolated-call") {
                return [];
            }
            if (channel.quality !== "ready") {
                return [
                    {
                        index: line.index,
                        match: {
                            model: "unavailable",
                            candidates: [],
                            quality: "unknown" as const,
                            reason: channel.reason,
                        },
                    },
                ];
            }
            const samples = options.samples.filter(
                (sample) =>
                    sample.source !== channel.source.audioPath ||
                    sample.channel !== channel.channel ||
                    sample.toSec <= channel.fromSec ||
                    sample.fromSec >= channel.toSec
            );
            return [
                {
                    index: line.index,
                    match: scoreVoice({
                        model: channel.model,
                        embedding: channel.embedding,
                        samples,
                        threshold: options.threshold,
                        margin: options.margin,
                    }),
                },
            ];
        })
    );
}
