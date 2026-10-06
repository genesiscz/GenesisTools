import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import {
    cellValueSchema,
    newRecastID,
    type RecastDocument,
    type RecastRecord,
    type RecastRegion,
    readRecastDocument,
    recastID,
    unknownCell,
} from "./document";
import { validateFieldValue } from "./validation";

export const recastProposalSchema = z
    .object({
        explanation: z.string().max(2000),
        records: z
            .array(
                z
                    .object({
                        fields: z
                            .array(
                                z
                                    .object({
                                        fieldId: z.string().min(1).max(64),
                                        value: cellValueSchema,
                                        evidence: z
                                            .array(
                                                z
                                                    .object({
                                                        readingId: z.string().min(1).max(64),
                                                        quote: z.string().min(1).max(8000),
                                                    })
                                                    .strict()
                                            )
                                            .max(8),
                                        note: z.string().max(1000),
                                    })
                                    .strict()
                            )
                            .max(32),
                    })
                    .strict()
            )
            .max(50),
    })
    .strict();

function proposalRegion(region: RecastRegion) {
    if (region.kind === "text") {
        return { kind: region.kind, start: region.start, end: region.end };
    }
    return region;
}

export function recastProposalContext({
    input,
    collectionId,
    readingIds,
}: {
    input: unknown;
    collectionId: string;
    readingIds: string[];
}) {
    const document = readRecastDocument(input);
    const collection = document.collections.find((entry) => entry.id === collectionId);
    if (!collection) {
        throw new Error("Choose a destination collection.");
    }
    const requested = z.array(recastID).min(1).max(200).parse(readingIds);
    const chosen = new Set(requested);
    if (chosen.size !== requested.length) {
        throw new Error("Choose each literal reading only once.");
    }
    const readings = document.readings.filter((reading) => chosen.has(reading.id));
    if (readings.length !== chosen.size) {
        throw new Error("A selected reading is missing from this conversion. Nothing was sent.");
    }
    const anchors = new Map(document.anchors.map((anchor) => [anchor.id, anchor]));
    const sources = new Map(document.sources.map((source) => [source.id, source]));
    const context = {
        collection,
        readings: readings.map(({ id, text, alternatives, anchorId }) => {
            const anchor = anchors.get(anchorId)!;
            const source = sources.get(anchor.sourceId)!;
            return {
                id,
                text,
                alternatives,
                source: { id: source.id, name: source.name, contentHash: source.contentHash },
                region: proposalRegion(anchor.region),
            };
        }),
    };
    const sourceIds = [...new Set(context.readings.map((reading) => reading.source.id))];
    const serialized = SafeJSON.stringify(context);
    if (serialized.length > 32000) {
        throw new Error("The selected readings exceed 32,000 characters. Use a smaller source selection.");
    }
    return {
        document,
        collection,
        sourceIds,
        readingIds: readings.map((reading) => reading.id),
        readings,
        serialized,
        contextHash: createHash("sha256").update(serialized).digest("hex"),
    };
}

export function previewRecastProposalInput(args: Parameters<typeof recastProposalContext>[0]) {
    const context = recastProposalContext(args);
    return {
        documentId: context.document.id,
        revision: context.document.revision,
        collectionId: context.collection.id,
        readingIds: context.readingIds,
        sourceIds: context.sourceIds,
        contextHash: context.contextHash,
        serialized: context.serialized,
        characters: context.serialized.length,
    };
}

export function inspectRecastProposal({
    input,
    document,
    collectionId,
    readingIds,
    at = new Date().toISOString(),
}: {
    input: unknown;
    document: RecastDocument;
    collectionId: string;
    readingIds: string[];
    at?: string;
}) {
    const context = recastProposalContext({ input: document, collectionId, readingIds });
    const proposal = recastProposalSchema.parse(input);
    const warnings: string[] = [];
    const records: RecastRecord[] = proposal.records.map((entry, index) => {
        const cells = Object.fromEntries(context.collection.fields.map((field) => [field.id, unknownCell()]));
        const seen = new Set<string>();
        for (const input of entry.fields) {
            const field = context.collection.fields.find((field) => field.id === input.fieldId);
            if (!field || seen.has(input.fieldId)) {
                throw new Error("AI returned an unknown or repeated field. Nothing was applied.");
            }
            seen.add(input.fieldId);
            const readingIds = new Set<string>();
            const anchorIds = new Set<string>();
            for (const evidence of input.evidence) {
                const reading = context.readings.find((reading) => reading.id === evidence.readingId);
                if (
                    !reading ||
                    ![reading.text, ...reading.alternatives].some((text) => text.includes(evidence.quote))
                ) {
                    throw new Error(
                        "AI cited a reading or quotation outside the selected readings. Nothing was applied."
                    );
                }
                readingIds.add(reading.id);
                anchorIds.add(reading.anchorId);
            }
            const issue = validateFieldValue(input.value, { ...field, required: false });
            const ungrounded = input.value !== null && readingIds.size === 0;
            const value = issue || ungrounded ? null : input.value;
            const note =
                issue ?? (ungrounded ? "No source evidence was supplied. Provide a value yourself." : input.note);
            if (issue || ungrounded) {
                warnings.push(`Row ${index + 1}, ${field.label}: ${note}`);
            }
            cells[field.id] = {
                value,
                state: value === null ? "unknown" : "proposed",
                origin: "inferred",
                anchorIds: [...anchorIds],
                readingIds: [...readingIds],
                alternatives: [],
                note,
            };
        }
        return {
            id: newRecastID("record"),
            collectionId,
            state: "draft",
            cells,
            createdAt: at,
        };
    });
    return {
        documentId: document.id,
        revision: document.revision,
        collectionId,
        sourceIds: context.sourceIds,
        readingIds: context.readingIds,
        contextHash: context.contextHash,
        explanation: proposal.explanation,
        records,
        warnings,
    };
}
