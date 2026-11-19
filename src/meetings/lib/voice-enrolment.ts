import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { type LineEmbedding, scoreVoice, type VoiceMatch, type VoiceSample } from "@genesiscz/utils/meetings/voice";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";
import { personKey } from "./listen-answers";
import type { OpenedMeeting } from "./opened-meeting";

/** The legacy command delegates to the shared suggestion writer; it never invents training prints. */
export async function enrolMeetingVoices(options: {
    opened: OpenedMeeting;
    store: MeetingStore;
}): Promise<{ samples: number; matched: number; unknown: number }> {
    const { runSuggest } = await import("./suggest-run");
    const record = options.opened.record;
    if (!record.project) {
        throw new Error("Choose a project before naming voices");
    }
    const { readVoiceStore } = await import("@genesiscz/utils/meetings/voice-store");
    const result = await runSuggest({ store: options.store, record, rules: ["speakers"] });
    return {
        samples: Object.values(readVoiceStore(record.project).people).reduce(
            (sum, person) => sum + person.samples.length,
            0
        ),
        matched: result.fresh.filter(
            (item) => item.kind === "speaker-range" && item.rules.includes(MeetingRule.VoiceEmbedding)
        ).length,
        unknown: result.fresh.filter((item) => item.kind === "question" && item.about === "speaker").length,
    };
}

export interface RemoteStay {
    name: string;
    fromSec: number;
    toSec: number;
}

/**
 * The windows each remote seat's person can speak in: the seat's bounds (its start defaults to the first time the
 * person was seen), cut to that person's stays in the call, so a departure and a rejoin stay separate windows. A
 * person the presence does not name keeps the seat's bounds.
 */
export function remoteStays(options: {
    record: MeetingRecord;
    presence: readonly Presence[] | undefined;
    endSec: number;
}): RemoteStay[] {
    const { record } = options;

    return (record.seats?.remote ?? []).flatMap((seat): RemoteStay[] => {
        const fromSec =
            seat.fromSec ?? record.participants.find((person) => person.name === seat.name)?.firstSeenSec ?? 0;
        const toSec = seat.toSec ?? options.endSec;
        const stays = options.presence?.filter((stay) => personKey(stay.name) === personKey(seat.name)) ?? [];

        if (stays.length === 0) {
            return [{ name: seat.name, fromSec, toSec }];
        }

        return stays.flatMap((stay) => {
            const from = Math.max(fromSec, stay.fromSec);
            const to = Math.min(toSec, stay.toSec);
            return to > from ? [{ name: seat.name, fromSec: from, toSec: to }] : [];
        });
    });
}

/**
 * Enrol isolated call audio only when one remote person is possible, or a human confirmed the line. A window that a
 * confirmed multi-voice range overlaps is never enrolled, and the one-person fallback needs that nobody else's stay
 * touches the window at all: a join or a departure inside it can put a second voice there.
 */
export function enrolRemoteVoices(options: {
    record: MeetingRecord;
    embeddings: readonly LineEmbedding[];
    remote: readonly RemoteStay[];
    labels?: ReadonlyMap<number, string>;
}): VoiceSample[] {
    const samples: VoiceSample[] = [];
    const mixedRanges = options.record.items.flatMap((item) =>
        item.kind === "speaker-range" && item.status === "confirmed" && (item.voices?.length ?? 0) > 1 ? [item] : []
    );
    for (const line of options.embeddings) {
        for (const channel of line.channels) {
            if (channel.quality !== "ready" || channel.track !== "isolated-call") {
                continue;
            }
            if (mixedRanges.some((item) => item.fromSec <= channel.toSec && item.toSec >= channel.fromSec)) {
                continue;
            }

            const covering = new Set<string>();
            const touching = new Set<string>();
            for (const stay of options.remote) {
                if (stay.fromSec <= channel.fromSec && stay.toSec >= channel.toSec) {
                    covering.add(stay.name);
                }
                if (stay.fromSec < channel.toSec && stay.toSec > channel.fromSec) {
                    touching.add(stay.name);
                }
            }
            const present = [...covering];
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
            const alone = present.length === 1 && touching.size === 1;
            const person = names.length === 1 ? names[0] : names.length === 0 && alone ? present[0] : undefined;
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
