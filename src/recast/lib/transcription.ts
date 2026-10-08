import type { TranscriptionResult } from "@genesiscz/utils/ai/types";
import { z } from "zod";
import {
    type LiteralReading,
    newRecastID,
    type RecastAnchor,
    type RecastRecord,
    type RecastSource,
    readRecastDocument,
    recastID,
    unknownCell,
} from "./document";
import type { RecastOperation } from "./operations";

const segmentSchema = z
    .object({
        text: z.string().min(1).max(32000),
        startMs: z.number().finite().nonnegative(),
        endMs: z.number().finite().positive(),
    })
    .strict();
export const transcriptReviewSchema = z
    .object({
        id: recastID,
        documentId: recastID,
        revision: z.number().int().nonnegative(),
        sourceId: recastID,
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        startMs: z.number().finite().nonnegative(),
        endMs: z.number().finite().positive(),
        text: z.string().min(1).max(32000),
        engine: z.string().min(1).max(200),
        language: z.string().max(100).optional(),
        timing: z.enum(["segments", "selection"]),
        segments: z.array(segmentSchema).max(999),
        warnings: z.array(z.string().max(1000)).max(8),
    })
    .strict();
export type RecastTranscriptReview = z.infer<typeof transcriptReviewSchema>;

export function recastAudioSelection({
    input,
    sourceId,
    startMs,
    endMs,
}: {
    input: unknown;
    sourceId: string;
    startMs: number;
    endMs: number;
}) {
    const document = readRecastDocument(input);
    const source = document.sources.find((item) => item.id === sourceId);
    if (source?.kind !== "audio" || source.error || !source.durationMs) {
        throw new Error("Choose an audio source with a known duration.");
    }
    if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        startMs < 0 ||
        endMs <= startMs ||
        endMs > source.durationMs ||
        endMs - startMs > 900000
    ) {
        throw new Error("Choose a positive interval within the recording, at most fifteen minutes.");
    }
    return { document, source };
}

export function reviewRecastTranscript({
    input,
    sourceId,
    startMs,
    endMs,
    result,
    engine,
}: {
    input: unknown;
    sourceId: string;
    startMs: number;
    endMs: number;
    result: TranscriptionResult;
    engine: string;
}): RecastTranscriptReview {
    const { document, source } = recastAudioSelection({ input, sourceId, startMs, endMs });
    if (typeof result.text !== "string" || !result.text.trim()) {
        throw new Error("No speech was returned for this interval.");
    }
    if (result.text.length > 32000) {
        throw new Error("The transcript exceeds 32,000 characters. Transcribe a shorter interval.");
    }
    const segments = result.segments ?? [];
    let priorStart = -1;
    const validTiming =
        segments.length > 0 &&
        segments.length <= 999 &&
        segments.every((segment) => {
            const valid =
                typeof segment.text === "string" &&
                segment.text.trim().length > 0 &&
                segment.text.length <= 32000 &&
                Number.isFinite(segment.start) &&
                Number.isFinite(segment.end) &&
                segment.start >= priorStart &&
                segment.start >= 0 &&
                segment.end > segment.start &&
                segment.end * 1000 <= endMs - startMs;
            priorStart = segment.start;
            return valid;
        });
    return transcriptReviewSchema.parse({
        id: newRecastID("transcript"),
        documentId: document.id,
        revision: document.revision,
        sourceId,
        sourceHash: source.contentHash,
        startMs,
        endMs,
        text: result.text,
        engine,
        language: result.language,
        timing: validTiming ? "segments" : "selection",
        segments: validTiming
            ? segments.map((segment) => ({
                  text: segment.text,
                  startMs: startMs + segment.start * 1000,
                  endMs: startMs + segment.end * 1000,
              }))
            : [],
        warnings: validTiming
            ? []
            : [
                  "The provider returned no usable timing for this selection. Evidence links cover the whole selected interval; no word times were invented.",
              ],
    });
}

function transcriptAnchor(source: RecastSource, item: { text: string; startMs: number; endMs: number }): RecastAnchor {
    return {
        id: newRecastID("anchor"),
        sourceId: source.id,
        sourceHash: source.contentHash,
        label: item.text.trim().slice(0, 80),
        region: { kind: "audio", startMs: item.startMs, endMs: item.endMs },
    };
}

export function captureRecastTranscript({
    input,
    review: rawReview,
    collectionId,
    mode,
    recordId,
    fieldId,
    at = new Date().toISOString(),
}: {
    input: unknown;
    review: unknown;
    collectionId: string;
    mode: "readings" | "rows" | "field";
    recordId?: string;
    fieldId?: string;
    at?: string;
}): RecastOperation[] {
    const review = transcriptReviewSchema.parse(rawReview);
    const { document, source } = recastAudioSelection({
        input,
        sourceId: review.sourceId,
        startMs: review.startMs,
        endMs: review.endMs,
    });
    if (
        document.id !== review.documentId ||
        document.revision !== review.revision ||
        source.contentHash !== review.sourceHash
    ) {
        throw new Error("The conversion changed. Transcribe this interval again before saving its readings.");
    }
    const collection = document.collections.find((item) => item.id === collectionId);
    if (!collection) {
        throw new Error("Choose an existing collection.");
    }
    if (
        review.segments.some(
            (segment) =>
                segment.startMs < review.startMs || segment.endMs > review.endMs || segment.endMs <= segment.startMs
        )
    ) {
        throw new Error("Transcript timing lies outside its selected source interval.");
    }
    if ((review.timing === "selection") !== (review.segments.length === 0)) {
        throw new Error("Transcript timing metadata does not match its readings.");
    }
    const full = { text: review.text, startMs: review.startMs, endMs: review.endMs };
    const items = [full, ...review.segments];
    const anchors = items.map((item) => transcriptAnchor(source, item));
    const readings: LiteralReading[] = items.map((item, index) => ({
        id: newRecastID("reading"),
        anchorId: anchors[index].id,
        text: item.text,
        alternatives: [],
        method: "transcript",
        engine: review.engine,
        createdAt: at,
    }));
    const records: RecastRecord[] = [];
    const firstField = collection.fields.find((field) => field.type === "text");
    if (mode === "rows") {
        if (!firstField) {
            throw new Error("Add a text field before creating rows from the transcript.");
        }
        const indices = review.segments.length ? review.segments.map((_, index) => index + 1) : [0];
        for (const index of indices) {
            const reading = readings[index];
            const fits = reading.text.length <= 8000;
            const cells = Object.fromEntries(collection.fields.map((field) => [field.id, unknownCell()]));
            cells[firstField.id] = {
                ...unknownCell(),
                value: fits ? reading.text : null,
                state: fits ? "proposed" : "unknown",
                anchorIds: [anchors[index].id],
                readingIds: [reading.id],
                origin: "source",
                note: fits
                    ? "Transcript; listen to the recording before accepting."
                    : "Reading exceeds the field limit. Supply a shorter reviewed value.",
            };
            records.push({
                id: newRecastID("record"),
                collectionId,
                state: "draft",
                cells,
                createdAt: at,
            });
        }
    }
    const operations: RecastOperation[] = [{ kind: "capture", anchors, readings, records }];
    if (mode === "field") {
        const record = document.records.find(
            (item) => item.id === recordId && item.collectionId === collectionId && item.state !== "archived"
        );
        const field = collection.fields.find((item) => item.id === fieldId);
        if (!record || !field) {
            throw new Error("Choose an active record and field for the transcript.");
        }
        const value = field.type === "text" && review.text.length <= 8000 ? review.text : null;
        operations.push({
            kind: "set-cell",
            recordId: record.id,
            fieldId: field.id,
            cell: {
                ...unknownCell(),
                value,
                state: value === null ? "unknown" : "proposed",
                anchorIds: [anchors[0].id],
                readingIds: [readings[0].id],
                origin: "source",
                note:
                    value === null
                        ? "Interpret the transcript as the required field type."
                        : "Transcript; listen before accepting.",
            },
            reason: "Read selected audio interval into field",
        });
    }
    return operations;
}
