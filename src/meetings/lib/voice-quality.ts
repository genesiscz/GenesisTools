import {
    type groupedOwners,
    idSchema,
    ownerKey as keyOfOwner,
    overlapsVoiceSource,
    ownerSchema,
    type PredictionPrints,
    type VoiceSample,
} from "@genesiscz/utils/meetings/voice-library";
import { z } from "zod";
import { addVector, dot, unit } from "./voice-names";

export const learntVoiceSchema = z.object({
    owner: ownerSchema,
    seat: z.enum(["mic", "call"]),
    track: z.enum(["source-mic", "mic-raw", "source-call", "system"]),
    model: z.string(),
    dimension: z.number(),
    count: z.number(),
    independent: z.number(),
    meanCosine: z.number().nullable(),
    samples: z.array(
        z.object({
            id: idSchema,
            score: z.number().nullable(),
            outlier: z.boolean(),
            reason: z.enum(["zero-vector", "too-few-independent", "zero-centroid"]).optional(),
            neighborReason: z.literal("no-independent-compatible-neighbor").optional(),
            neighbor: z.object({ id: idSchema, owner: ownerSchema, score: z.number() }).nullable(),
        })
    ),
});
export type LearntVoice = z.infer<typeof learntVoiceSchema>;

function overlaps(a: VoiceSample, b: VoiceSample) {
    return overlapsVoiceSource(a, { ...b.source, fromSec: b.fromSec, toSec: b.toSec });
}

/** One sum per compatible owner group. Leave out every overlapping recording before a sample votes. */
export function learntVoices(
    prints: PredictionPrints,
    options: { outlierBelow: number; directory?: ReturnType<typeof groupedOwners> }
): LearntVoice[] {
    type Row = { sample: VoiceSample; vector?: number[] };
    type Group = { owner: VoiceSample["owner"]; rows: Row[]; independent: Row[]; sum: number[] };
    const spaces = new Map<string, Map<string | object, Group>>();
    for (const sample of prints.samples) {
        const space = [sample.seat, sample.track, prints.model, sample.embedding.length].join("\0");
        const owners = spaces.get(space) ?? new Map<string | object, Group>();
        spaces.set(space, owners);
        const ownerKey = options.directory?.binding(sample.owner) ?? keyOfOwner(sample.owner);
        const group: Group = owners.get(ownerKey) ?? {
            owner: typeof ownerKey === "string" ? sample.owner : ownerKey.owner,
            rows: [],
            independent: [],
            sum: Array(sample.embedding.length).fill(0),
        };
        owners.set(ownerKey, group);
        const vector = unit(sample.embedding);
        const row = { sample, vector };
        group.rows.push(row);
        if (vector && !group.independent.some((other) => overlaps(other.sample, sample))) {
            group.independent.push(row);
            addVector(group.sum, vector, 1);
        }
    }
    const result: LearntVoice[] = [];
    for (const owners of spaces.values()) {
        for (const group of owners.values()) {
            const first = group.rows[0]!.sample;
            const count = group.independent.length;
            const length = Math.hypot(...group.sum);
            const usable = length > Number.EPSILON * count;
            result.push({
                owner: group.owner,
                seat: first.seat,
                track: first.track,
                model: prints.model,
                dimension: first.embedding.length,
                count: group.rows.length,
                independent: count,
                meanCosine: count >= 3 && usable ? Math.min(1, length / count) : null,
                samples: group.rows.map(({ sample, vector }) => {
                    const sum = [...group.sum];
                    let others = count;
                    for (const row of group.independent) {
                        if (overlaps(row.sample, sample)) {
                            addVector(sum, row.vector!, -1);
                            others--;
                        }
                    }
                    const norm = Math.hypot(...sum);
                    const reason = !vector
                        ? "zero-vector"
                        : others < 2
                          ? "too-few-independent"
                          : !usable || norm <= Number.EPSILON * others
                            ? "zero-centroid"
                            : undefined;
                    const score = reason ? null : Math.max(-1, Math.min(1, dot(sum, vector!) / norm));
                    let neighbor: LearntVoice["samples"][number]["neighbor"] = null;
                    if (vector) {
                        for (const other of owners.values()) {
                            if (other === group) {
                                continue;
                            }
                            for (const candidate of other.rows) {
                                if (candidate.vector && !overlaps(candidate.sample, sample)) {
                                    const similarity = Math.max(-1, Math.min(1, dot(vector, candidate.vector)));
                                    if (!neighbor || neighbor.score < similarity) {
                                        neighbor = { id: candidate.sample.id, owner: other.owner, score: similarity };
                                    }
                                }
                            }
                        }
                    }
                    return {
                        id: sample.id,
                        score,
                        outlier: score !== null && score < options.outlierBelow,
                        reason,
                        neighbor,
                        neighborReason: neighbor ? undefined : ("no-independent-compatible-neighbor" as const),
                    };
                }),
            });
        }
    }
    return result;
}
