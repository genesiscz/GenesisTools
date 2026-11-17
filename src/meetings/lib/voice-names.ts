import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import { type LineEmbedding, scoreVoice, type VoiceSample } from "@genesiscz/utils/meetings/voice";
import type { VoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { Seat, TrackKind } from "./sound";
import type { LabelContext, LineLabel } from "./speaker-labels/types";

export type VoiceGate = MeetingsConfig["global"]["speakerLabels"]["voice"]["gate"];
export type VoiceLine = LineEmbedding & { seat: Seat; track: TrackKind; fromSec?: number; toSec?: number };

/** Normalise each print before averaging, so a louder vector cannot dominate a person's prototype. */
export function meanVoice(embeddings: readonly number[][]): number[] | undefined {
    const dimension = embeddings[0]?.length ?? 0;
    if (!dimension) {
        return undefined;
    }
    const sum = Array<number>(dimension).fill(0);
    let count = 0;
    for (const vector of embeddings) {
        const length = Math.hypot(...vector);
        if (vector.length !== dimension || !Number.isFinite(length) || length === 0) {
            continue;
        }
        for (let index = 0; index < dimension; index++) {
            sum[index]! += vector[index]! / length;
        }
        count++;
    }
    const length = Math.hypot(...sum);
    return count && length > 0 ? sum.map((value) => value / length) : undefined;
}

/** Pure seat- and time-scoped proposals. Scores are cosine similarities, never probabilities. */
export function nameByVoice(options: {
    lines: readonly VoiceLine[];
    store: VoiceStore;
    attended: LabelContext["attended"];
    gate: VoiceGate;
    minSeconds: number;
}): LineLabel[] {
    const { gate, store } = options;
    return options.lines.map((line): LineLabel => {
        const base = { labeler: "voice" as const, index: line.index, seat: line.seat };
        const voice = line.channels.find((channel) => channel.quality === "ready");
        const fromSec = line.fromSec ?? voice?.fromSec;
        const toSec = line.toSec ?? voice?.toSec;
        if (
            voice?.quality !== "ready" ||
            fromSec === undefined ||
            toSec === undefined ||
            toSec - fromSec < options.minSeconds ||
            voice.model !== store.model ||
            !meanVoice([voice.embedding])
        ) {
            return { ...base, reason: "no-voice" };
        }
        const people = [
            ...new Set(
                options.attended
                    .filter((stay) => stay.seat === line.seat && stay.fromSec <= fromSec && stay.toSec >= toSec)
                    .map((stay) => stay.person)
            ),
        ];
        const samples: VoiceSample[] = people.flatMap((person) => {
            const prints = Object.entries(store.people)
                .filter(([name]) => sameName(name, person))
                .flatMap(([, value]) => value.samples)
                .filter((print) => print.seat === line.seat && print.track === line.track);
            const embedding = meanVoice(prints.map((print) => print.embedding));
            return embedding
                ? [
                      {
                          person,
                          embedding,
                          model: store.model,
                          source: "project-mean",
                          channel: voice.channel,
                          fromSec: 0,
                          toSec: 1,
                          confirmed: true,
                      },
                  ]
                : [];
        });
        const missing = people.find((person) => !samples.some((sample) => sameName(sample.person, person)));
        const [first, second] = scoreVoice({ model: store.model, embedding: voice.embedding, samples }).candidates;
        if (!first) {
            return {
                ...base,
                reason: missing ? "unsampled-present" : "no-rival-sample",
                ...(missing ? { next: { person: missing, score: 0 } } : {}),
            };
        }
        const scored = { ...base, score: first.score, ...(second ? { next: second } : {}) };
        if (people.length === 1 && first.score < gate.strangerScore) {
            return { ...scored, next: first, reason: "not-the-seat-person" };
        }
        if (missing && first.score < gate.unsampledScore) {
            return { ...scored, next: { person: missing, score: 0 }, reason: "unsampled-present" };
        }
        if (!second && first.score < gate.loneScore) {
            return { ...scored, reason: "no-rival-sample" };
        }
        if (first.score < gate.score || (second && first.score - second.score < gate.margin)) {
            return { ...scored, reason: "below-gate" };
        }
        return { ...scored, person: first.person, reason: "named" };
    });
}
