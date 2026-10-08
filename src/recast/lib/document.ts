import { randomUUID } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";

export const RECAST_LIMITS = {
    sources: 128,
    images: 10,
    pages: 100,
    audioMs: 15 * 60 * 1000,
    records: 2000,
    corrections: 10000,
    journal: 10000,
    renderings: 32,
    anchors: 20000,
    links: 5000,
    readings: 20000,
    assetBytes: 100 * 1024 * 1024,
    packageBytes: 512 * 1024 * 1024,
    manifestBytes: 32 * 1024 * 1024,
} as const;
export const recastID = z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .refine((value) => !["constructor", "prototype", "__proto__"].includes(value), "Reserved identifier.");
const label = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const timestamp = z.string().datetime({ offset: false });
export const cellValueSchema = z.union([z.string().max(8000), finite, z.boolean(), z.null()]);
export type CellValue = z.infer<typeof cellValueSchema>;

export const sourceSchema = z
    .object({
        id: recastID,
        name: z.string().trim().min(1).max(1024),
        contentHash: digest,
        assetName: z.string().regex(/^[a-f0-9]{64}\.[a-z0-9]{1,10}$/),
        mime: z.string().min(1).max(160),
        kind: z.enum(["image", "pdf", "text", "audio", "unsupported"]),
        bytes: z.number().int().min(0).max(RECAST_LIMITS.assetBytes),
        importedAt: timestamp,
        externalLocation: z.string().max(8192).optional(),
        pageCount: z.number().int().min(1).max(RECAST_LIMITS.pages).optional(),
        pages: z
            .array(
                z
                    .object({
                        index: z.number().int().min(0).max(99),
                        width: finite.positive().max(100000),
                        height: finite.positive().max(100000),
                    })
                    .strict()
            )
            .max(RECAST_LIMITS.pages)
            .default([]),
        textLength: z
            .number()
            .int()
            .min(0)
            .max(16 * 1024 * 1024)
            .optional(),
        durationMs: finite.positive().max(RECAST_LIMITS.audioMs).optional(),
        error: z.string().max(4000).optional(),
        replaces: recastID.optional(),
    })
    .strict();
export type RecastSource = z.infer<typeof sourceSchema>;

export const regionSchema = z.discriminatedUnion("kind", [
    z
        .object({
            kind: z.literal("rect"),
            page: z.number().int().min(0).max(99),
            x: finite.min(0).max(1),
            y: finite.min(0).max(1),
            width: finite.positive().max(1),
            height: finite.positive().max(1),
        })
        .strict(),
    z
        .object({
            kind: z.literal("text"),
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
            quote: z.string().min(1).max(32000),
            prefix: z.string().max(160).default(""),
            suffix: z.string().max(160).default(""),
        })
        .strict(),
    z
        .object({
            kind: z.literal("audio"),
            startMs: finite.nonnegative(),
            endMs: finite.positive().max(RECAST_LIMITS.audioMs),
        })
        .strict(),
    z.object({ kind: z.literal("whole") }).strict(),
]);
export type RecastRegion = z.infer<typeof regionSchema>;

export const anchorSchema = z
    .object({
        id: recastID,
        sourceId: recastID,
        sourceHash: digest,
        label,
        region: regionSchema,
        fingerprint: digest.optional(),
    })
    .strict();
export type RecastAnchor = z.infer<typeof anchorSchema>;

export const readingSchema = z
    .object({
        id: recastID,
        anchorId: recastID,
        text: z.string().max(32000),
        alternatives: z.array(z.string().max(32000)).max(8).default([]),
        method: z.enum(["manual", "pdf-text", "vision-ocr", "transcript"]),
        engine: z.string().max(200),
        createdAt: timestamp,
    })
    .strict();
export type LiteralReading = z.infer<typeof readingSchema>;

export const fieldSchema = z
    .object({
        id: recastID,
        label,
        type: z.enum(["text", "number", "boolean", "date", "datetime", "timezone"]),
        required: z.boolean(),
    })
    .strict();
export const collectionSchema = z
    .object({
        id: recastID,
        label,
        kind: z.enum(["table", "checklist", "calendar"]),
        fields: z.array(fieldSchema).min(1).max(32),
    })
    .strict();
export type RecastCollection = z.infer<typeof collectionSchema>;

export const cellSchema = z
    .object({
        value: cellValueSchema,
        state: z.enum(["unknown", "proposed", "accepted"]),
        origin: z.enum(["source", "inferred", "user"]),
        anchorIds: z.array(recastID).max(16).default([]),
        readingIds: z.array(recastID).max(16).default([]),
        alternatives: z.array(cellValueSchema).max(8).default([]),
        note: z.string().max(4000).default(""),
    })
    .strict();
export type RecastCell = z.infer<typeof cellSchema>;

export const recordSchema = z
    .object({
        id: recastID,
        collectionId: recastID,
        state: z.enum(["draft", "accepted", "archived"]),
        cells: z.record(recastID, cellSchema),
        createdAt: timestamp,
    })
    .strict();
export type RecastRecord = z.infer<typeof recordSchema>;

const correctionSchema = z
    .object({
        id: recastID,
        recordId: recastID,
        fieldId: recastID,
        before: cellSchema,
        after: cellSchema,
        reason: z.string().min(1).max(4000),
        createdAt: timestamp,
    })
    .strict();

export const reconciliationSchema = z
    .object({
        id: recastID,
        oldSourceId: recastID,
        newSourceId: recastID,
        createdAt: timestamp,
        items: z
            .array(
                z
                    .object({
                        oldAnchorId: recastID,
                        status: z.enum(["pending", "kept", "relinked"]),
                        newAnchorId: recastID.optional(),
                    })
                    .strict()
            )
            .max(RECAST_LIMITS.links),
    })
    .strict();
export type RecastReconciliation = z.infer<typeof reconciliationSchema>;

export const renderingReceiptSchema = z
    .object({
        id: recastID,
        documentId: recastID,
        revision: z.number().int().nonnegative(),
        collectionId: recastID,
        format: z.enum(["csv", "markdown", "json", "ics"]),
        createdAt: timestamp,
        contentHash: digest,
        includeRecordIds: z.boolean(),
        fields: z.array(fieldSchema).min(1).max(32),
        rows: z
            .array(
                z
                    .object({
                        id: recastID,
                        values: z.record(recastID, cellValueSchema),
                    })
                    .strict()
            )
            .min(1)
            .max(RECAST_LIMITS.records),
    })
    .strict();
export type RenderingReceipt = z.infer<typeof renderingReceiptSchema>;

export const contradictionSchema = z
    .object({
        id: recastID,
        collectionId: recastID,
        fieldId: recastID,
        label,
        reason: z.string().trim().min(1).max(4000),
        createdAt: timestamp,
        status: z.enum(["pending", "resolved"]),
        decision: z.enum(["keep-both", "prefer", "context"]).optional(),
        preferredRecordId: recastID.optional(),
        resolvedAt: timestamp.optional(),
        members: z
            .array(z.object({ recordId: recastID, cell: cellSchema, context: z.string().max(4000) }).strict())
            .min(2)
            .max(8),
    })
    .strict();
export type RecastContradiction = z.infer<typeof contradictionSchema>;

export const documentSchema = z
    .object({
        format: z.literal("genesis-recast"),
        version: z.literal(2),
        id: recastID,
        title: label,
        revision: z.number().int().nonnegative(),
        sources: z.array(sourceSchema).max(RECAST_LIMITS.sources),
        anchors: z.array(anchorSchema).max(RECAST_LIMITS.anchors),
        readings: z.array(readingSchema).max(RECAST_LIMITS.readings),
        collections: z.array(collectionSchema).min(1).max(32),
        records: z.array(recordSchema).max(RECAST_LIMITS.records),
        corrections: z.array(correctionSchema).max(RECAST_LIMITS.corrections),
        renderings: z.array(renderingReceiptSchema).max(RECAST_LIMITS.renderings).default([]),
        reconciliations: z.array(reconciliationSchema).max(128).default([]),
        contradictions: z.array(contradictionSchema).max(256),
        journal: z
            .array(
                z
                    .object({
                        id: recastID,
                        revision: z.number().int().positive(),
                        at: timestamp,
                        action: label,
                        recordIds: z.array(recastID).max(RECAST_LIMITS.records),
                    })
                    .strict()
            )
            .max(RECAST_LIMITS.journal),
    })
    .strict();
export type RecastDocument = z.infer<typeof documentSchema>;

export function newRecastID(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function unique<T extends { id: string }>(values: T[], name: string): Map<string, T> {
    const result = new Map(values.map((value) => [value.id, value]));

    if (result.size !== values.length) {
        throw new Error(`Duplicate ${name} identifier.`);
    }

    return result;
}

export function validateRegion(anchor: RecastAnchor, source: RecastSource): void {
    if (anchor.sourceHash !== source.contentHash) {
        throw new Error(`Evidence belongs to a different source snapshot: ${anchor.label}`);
    }

    const region = anchor.region;

    if (region.kind === "rect") {
        if (
            !["image", "pdf"].includes(source.kind) ||
            region.page >= (source.pageCount ?? 0) ||
            region.x + region.width > 1 + 1e-9 ||
            region.y + region.height > 1 + 1e-9
        ) {
            throw new Error("A selected rectangle must stay inside an existing source page.");
        }
    } else if (region.kind === "text") {
        if (
            source.kind !== "text" ||
            region.start >= region.end ||
            region.end > (source.textLength ?? 0) ||
            region.quote.length !== region.end - region.start
        ) {
            throw new Error("A text anchor must use valid UTF-16 offsets and the exact selected text.");
        }
    } else if (region.kind === "audio") {
        if (source.kind !== "audio" || region.startMs >= region.endMs || region.endMs > (source.durationMs ?? 0)) {
            throw new Error("An audio anchor must stay inside a known source duration.");
        }
    }
}

export function sameRecastEvidence(a: RecastCell, b: RecastCell): boolean {
    const { state: _aState, ...aEvidence } = a;
    const { state: _bState, ...bEvidence } = b;
    return SafeJSON.stringify(aEvidence) === SafeJSON.stringify(bEvidence);
}

export function readRecastDocument(input: unknown): RecastDocument {
    const legacy = z
        .object({ format: z.literal("genesis-recast"), version: z.literal(1) })
        .passthrough()
        .safeParse(input);
    if (legacy.success && "contradictions" in legacy.data) {
        throw new Error("Contradiction state requires Recast package version 2.");
    }

    const document = documentSchema.parse(legacy.success ? { ...legacy.data, version: 2, contradictions: [] } : input);
    const sources = unique(document.sources, "source");
    const anchors = unique(document.anchors, "anchor");
    const readings = unique(document.readings, "reading");
    const collections = unique(document.collections, "collection");
    const records = unique(document.records, "record");
    unique(document.corrections, "correction");
    unique(document.journal, "journal");
    unique(document.renderings, "rendering");
    unique(document.reconciliations, "reconciliation");
    for (const job of document.reconciliations) {
        if (
            !sources.has(job.oldSourceId) ||
            !sources.has(job.newSourceId) ||
            job.oldSourceId === job.newSourceId ||
            new Set(job.items.map((item) => item.oldAnchorId)).size !== job.items.length
        ) {
            throw new Error("Invalid source reconciliation identity.");
        }
        for (const item of job.items) {
            if (
                anchors.get(item.oldAnchorId)?.sourceId !== job.oldSourceId ||
                (item.status === "relinked" &&
                    (!item.newAnchorId || anchors.get(item.newAnchorId)?.sourceId !== job.newSourceId)) ||
                (item.status !== "relinked" && item.newAnchorId !== undefined)
            ) {
                throw new Error("A reconciliation decision lost its source evidence.");
            }
        }
    }
    for (const source of document.sources) {
        const seen = new Set([source.id]);
        let previous = source.replaces;
        while (previous) {
            if (seen.has(previous)) {
                throw new Error("Source replacements must not form a cycle.");
            }
            seen.add(previous);
            previous = sources.get(previous)?.replaces;
        }
    }
    for (const rendering of document.renderings) {
        if (
            rendering.documentId !== document.id ||
            rendering.revision > document.revision ||
            !collections.has(rendering.collectionId)
        ) {
            throw new Error("An export receipt does not belong to this conversion.");
        }
        const fields = unique(rendering.fields, "export field");
        unique(rendering.rows, "export record");
        for (const row of rendering.rows) {
            if (
                records.get(row.id)?.collectionId !== rendering.collectionId ||
                Object.keys(row.values).some((key) => !fields.has(key)) ||
                rendering.fields.some((field) => !(field.id in row.values))
            ) {
                throw new Error("An export receipt lost its record or field identity.");
            }
        }
    }

    const assetSizes = new Map<string, number>();
    for (const source of document.sources) {
        const savedSize = assetSizes.get(source.assetName);
        if (savedSize !== undefined && savedSize !== source.bytes) {
            throw new Error("Shared source snapshots must declare the same byte size.");
        }

        assetSizes.set(source.assetName, source.bytes);
    }

    if (
        document.sources.filter((source) => source.kind === "image").length > RECAST_LIMITS.images ||
        [...assetSizes.values()].reduce((total, bytes) => total + bytes, 0) > RECAST_LIMITS.packageBytes
    ) {
        throw new Error("A conversion supports ten images and at most 512 MiB of source snapshots.");
    }

    for (const source of document.sources) {
        if (
            !source.assetName.startsWith(`${source.contentHash}.`) ||
            (source.replaces && (!sources.has(source.replaces) || source.replaces === source.id))
        ) {
            throw new Error("Invalid source asset identity or replacement.");
        }

        if (
            (source.kind === "image" && source.pageCount !== 1) ||
            (source.kind === "pdf" && source.pageCount === undefined) ||
            (source.kind === "text" && source.textLength === undefined) ||
            (source.kind === "audio" && source.durationMs === undefined)
        ) {
            throw new Error("Source metadata is missing the limits needed for safe selection.");
        }

        const pageIDs = new Set(source.pages.map((page) => page.index));
        if (
            pageIDs.size !== source.pages.length ||
            source.pages.some((page) => page.index >= (source.pageCount ?? 0))
        ) {
            throw new Error("Source page metadata contains missing or duplicate page identities.");
        }
    }

    for (const anchor of anchors.values()) {
        const source = sources.get(anchor.sourceId);
        if (!source) {
            throw new Error("An evidence region references a missing source.");
        }
        validateRegion(anchor, source);
    }

    for (const reading of readings.values()) {
        if (!anchors.has(reading.anchorId)) {
            throw new Error("A literal reading references a missing source region.");
        }
    }

    for (const collection of collections.values()) {
        unique(collection.fields, "field");

        if (
            collection.kind === "calendar" &&
            !["title", "start", "end", "timezone"].every((key) => collection.fields.some((field) => field.id === key))
        ) {
            throw new Error("Calendar collections need title, start, end and timezone fields.");
        }

        if (collection.kind === "checklist" && !collection.fields.some((field) => field.id === "title")) {
            throw new Error("A checklist needs a title field.");
        }
    }

    let links = 0;
    const validateCell = (cell: RecastCell) => {
        if ((cell.value === null) !== (cell.state === "unknown")) {
            throw new Error("An unknown value stays explicitly null until supplied.");
        }

        if (
            new Set(cell.anchorIds).size !== cell.anchorIds.length ||
            new Set(cell.readingIds).size !== cell.readingIds.length
        ) {
            throw new Error("A field repeats an evidence link.");
        }

        for (const id of cell.anchorIds) {
            if (!anchors.has(id)) {
                throw new Error("A field references a missing evidence region.");
            }
        }

        for (const id of cell.readingIds) {
            const reading = readings.get(id);
            if (!reading || !cell.anchorIds.includes(reading.anchorId)) {
                throw new Error("A literal reading must be attached through its own source region.");
            }
        }

        if (cell.state === "accepted" && cell.origin !== "user" && cell.anchorIds.length === 0) {
            throw new Error(
                "An accepted extracted or inferred value needs evidence; identify a manual value as user-supplied."
            );
        }
    };

    for (const record of records.values()) {
        const collection = collections.get(record.collectionId);
        if (!collection) {
            throw new Error("A record references a missing object collection.");
        }
        const fields = new Set(collection.fields.map((field) => field.id));

        if (Object.keys(record.cells).some((key) => !fields.has(key))) {
            throw new Error("A record contains an unknown field.");
        }

        for (const cell of Object.values(record.cells)) {
            validateCell(cell);
            if (record.state !== "archived") {
                links += cell.anchorIds.length;
            }
        }
    }

    for (const correction of document.corrections) {
        const record = records.get(correction.recordId);
        const collection = record ? collections.get(record.collectionId) : undefined;
        if (!collection?.fields.some((field) => field.id === correction.fieldId)) {
            throw new Error("A correction lost its record or field.");
        }
        validateCell(correction.before);
        validateCell(correction.after);
    }

    unique(document.contradictions, "contradiction");
    for (const review of document.contradictions) {
        const collection = collections.get(review.collectionId);
        if (
            !collection?.fields.some((field) => field.id === review.fieldId) ||
            new Set(review.members.map((member) => member.recordId)).size !== review.members.length
        ) {
            throw new Error("A contradiction lost its collection, field or competing records.");
        }
        for (const member of review.members) {
            if (records.get(member.recordId)?.collectionId !== review.collectionId) {
                throw new Error("Competing records must belong to the same collection.");
            }
            validateCell(member.cell);
        }
        if (review.status === "resolved") {
            if (
                !review.decision ||
                !review.resolvedAt ||
                (review.decision === "prefer" &&
                    !review.members.some((member) => member.recordId === review.preferredRecordId)) ||
                (review.decision !== "prefer" && review.preferredRecordId !== undefined) ||
                (review.decision === "context" && review.members.some((member) => !member.context.trim()))
            ) {
                throw new Error("A contradiction decision is incomplete.");
            }
            if (
                review.members.some((member) => {
                    const record = records.get(member.recordId)!;
                    const archived = review.decision === "prefer" && member.recordId !== review.preferredRecordId;
                    return (
                        !sameRecastEvidence(record.cells[review.fieldId] ?? unknownCell(), member.cell) ||
                        (archived ? record.state !== "archived" : record.state === "archived")
                    );
                })
            ) {
                throw new Error("Changed competing evidence requires a pending review.");
            }
        } else if (review.decision || review.resolvedAt || review.preferredRecordId) {
            throw new Error("A pending contradiction cannot retain a resolved decision.");
        }
    }

    if (links > RECAST_LIMITS.links) {
        throw new Error("A conversion supports at most 5,000 active evidence links.");
    }

    if (
        document.journal.some(
            (entry, index) =>
                entry.revision > document.revision ||
                (index > 0 && entry.revision <= document.journal[index - 1].revision)
        )
    ) {
        throw new Error("Operation journal revisions must increase and belong to this document.");
    }

    if (Buffer.byteLength(SafeJSON.stringify(document, { strict: true })) > RECAST_LIMITS.manifestBytes) {
        throw new Error("The conversion manifest exceeds 32 MiB.");
    }

    return document;
}

export function unknownCell(): RecastCell {
    return { value: null, state: "unknown", origin: "user", anchorIds: [], readingIds: [], alternatives: [], note: "" };
}

export function defaultCollection(kind: RecastCollection["kind"]): RecastCollection {
    const fields: RecastCollection["fields"] =
        kind === "calendar"
            ? [
                  { id: "title", label: "Title", type: "text", required: true },
                  { id: "start", label: "Start", type: "datetime", required: true },
                  { id: "end", label: "End", type: "datetime", required: true },
                  { id: "timezone", label: "Time zone", type: "timezone", required: true },
                  { id: "location", label: "Location", type: "text", required: false },
                  { id: "notes", label: "Notes", type: "text", required: false },
              ]
            : kind === "checklist"
              ? [
                    { id: "title", label: "Task", type: "text", required: true },
                    { id: "done", label: "Done", type: "boolean", required: false },
                    { id: "notes", label: "Notes", type: "text", required: false },
                ]
              : [
                    { id: "name", label: "Name", type: "text", required: true },
                    { id: "value", label: "Value", type: "text", required: false },
                ];
    return {
        id: newRecastID("collection"),
        kind,
        label: kind === "calendar" ? "Calendar" : kind === "checklist" ? "Checklist" : "Table",
        fields,
    };
}

export function newRecastDocument({ title = "Untitled conversion" }: { title?: string } = {}): RecastDocument {
    return readRecastDocument({
        format: "genesis-recast",
        version: 2,
        contradictions: [],
        id: newRecastID("recast"),
        title,
        revision: 0,
        sources: [],
        anchors: [],
        readings: [],
        collections: [defaultCollection("table")],
        records: [],
        corrections: [],
        journal: [],
    });
}
