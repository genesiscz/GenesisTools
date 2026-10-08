import { z } from "zod";
import { applyContradictionDecision, refreshContradictions, startContradiction } from "./contradictions";
import { previewCorrectionExamples } from "./correction-examples";
import {
    anchorSchema,
    cellSchema,
    cellValueSchema,
    collectionSchema,
    newRecastID,
    RECAST_LIMITS,
    type RecastCell,
    type RecastDocument,
    type RecastRecord,
    readingSchema,
    readRecastDocument,
    recordSchema,
    renderingReceiptSchema,
    sourceSchema,
    unknownCell,
} from "./document";
import { activeSourceAnchors } from "./reconcile";
import { previewRoundTrip } from "./roundtrip";
import { pendingReconciliationAnchors, recordIssues, validateFieldValue } from "./validation";

const operationID = z.string().min(1).max(64);
export const recastOperationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("add-source"), source: z.unknown() }).strict(),
    z.object({ kind: z.literal("add-anchor"), anchor: z.unknown(), reading: z.unknown().optional() }).strict(),
    z.object({ kind: z.literal("add-reading"), reading: z.unknown() }).strict(),
    z
        .object({
            kind: z.literal("capture"),
            anchors: z.array(z.unknown()).min(1).max(1000),
            readings: z.array(z.unknown()).max(1000),
            records: z.array(z.unknown()).max(1000),
        })
        .strict(),
    z.object({ kind: z.literal("add-collection"), collection: z.unknown() }).strict(),
    z.object({ kind: z.literal("add-record"), collectionId: operationID, id: operationID.optional() }).strict(),
    z.object({ kind: z.literal("add-proposals"), records: z.array(z.unknown()).min(1).max(2000) }).strict(),
    z
        .object({
            kind: z.literal("set-cell"),
            recordId: operationID,
            fieldId: operationID,
            cell: z.unknown(),
            reason: z.string().min(1).max(4000),
        })
        .strict(),
    z
        .object({
            kind: z.literal("attach-anchor"),
            recordId: operationID,
            fieldId: operationID,
            anchorId: operationID,
        })
        .strict(),
    z
        .object({
            kind: z.literal("set-evidence"),
            recordId: operationID,
            fieldId: operationID,
            anchorIds: z.array(operationID).max(16),
            readingIds: z.array(operationID).max(16),
            reason: z.string().trim().min(1).max(4000),
        })
        .strict(),
    z
        .object({
            kind: z.literal("start-contradiction"),
            id: operationID.optional(),
            collectionId: operationID,
            fieldId: operationID,
            recordIds: z.array(operationID).min(2).max(8),
            label: z.string().trim().min(1).max(200),
            reason: z.string().trim().min(1).max(4000),
        })
        .strict(),
    z
        .object({
            kind: z.literal("resolve-contradiction"),
            reviewId: operationID,
            decision: z.enum(["keep-both", "prefer", "context"]),
            preferredRecordId: operationID.optional(),
            contexts: z.record(operationID, z.string().trim().min(1).max(4000)).optional(),
            reason: z.string().trim().min(1).max(4000),
        })
        .strict(),
    z
        .object({
            kind: z.literal("bulk-correct"),
            collectionId: operationID,
            fieldId: operationID,
            recordIds: z.array(operationID).min(1).max(2000),
            value: cellValueSchema,
            note: z.string().max(4000),
            reason: z.string().trim().min(1).max(4000),
        })
        .strict(),
    z
        .object({
            kind: z.literal("reuse-correction"),
            recordId: operationID,
            fieldId: operationID,
            correctionId: operationID,
            reason: z.string().trim().min(1).max(4000),
        })
        .strict(),
    z.object({ kind: z.literal("accept-records"), recordIds: z.array(operationID).min(1).max(2000) }).strict(),
    z.object({ kind: z.literal("archive-records"), recordIds: z.array(operationID).min(1).max(2000) }).strict(),
    z.object({ kind: z.literal("rename"), title: z.string().trim().min(1).max(200) }).strict(),
    z.object({ kind: z.literal("record-rendering"), receipt: z.unknown() }).strict(),
    z.object({ kind: z.literal("forget-rendering"), receiptId: operationID }).strict(),
    z
        .object({
            kind: z.literal("start-reconciliation"),
            oldSourceId: operationID,
            newSourceId: operationID,
            id: operationID.optional(),
        })
        .strict(),
    z
        .object({
            kind: z.literal("resolve-reconciliation"),
            jobId: operationID,
            resolutions: z
                .array(
                    z
                        .object({
                            oldAnchorId: operationID,
                            decision: z.enum(["keep", "relink"]),
                            newAnchorId: operationID.optional(),
                        })
                        .strict()
                )
                .min(1)
                .max(5000),
        })
        .strict(),
    z
        .object({
            kind: z.literal("apply-roundtrip"),
            receiptId: operationID,
            csv: z.string().max(16 * 1024 * 1024),
            importChangeIds: z.array(z.string().min(1).max(140)).min(1).max(64000),
        })
        .strict(),
]);
export type RecastOperation = z.infer<typeof recastOperationSchema>;

function ownedRecord(document: RecastDocument, id: string): RecastRecord {
    const record = document.records.find((entry) => entry.id === id);
    if (!record) {
        throw new Error(`Unknown record: ${id}`);
    }
    return record;
}

function requireCorrectionCapacity(document: RecastDocument, count: number): void {
    const remaining = RECAST_LIMITS.corrections - document.corrections.length;
    if (count > remaining) {
        throw new Error(
            remaining === 0
                ? "Correction history is full (10,000 entries). Save this conversion and start a new conversion to continue."
                : `Correction history has room for ${remaining} more entries; this operation needs ${count}. Reduce the selected batch to ${remaining} records or fields.`
        );
    }
}

function correction({
    document,
    record,
    fieldId,
    cell,
    reason,
    at,
}: {
    document: RecastDocument;
    record: RecastRecord;
    fieldId: string;
    cell: RecastCell;
    reason: string;
    at: string;
}): void {
    requireCorrectionCapacity(document, 1);
    cell.state = cell.value === null ? "unknown" : "proposed";
    document.corrections.push({
        id: newRecastID("correction"),
        recordId: record.id,
        fieldId,
        before: structuredClone(record.cells[fieldId] ?? unknownCell()),
        after: structuredClone(cell),
        reason,
        createdAt: at,
    });
    record.cells[fieldId] = cell;
    record.state = "draft";
}

export function applyRecastOperation({
    input,
    operation: rawOperation,
    expectedRevision,
    at = new Date().toISOString(),
}: {
    input: unknown;
    operation: RecastOperation;
    expectedRevision: number;
    at?: string;
}): RecastDocument {
    const operation = recastOperationSchema.parse(rawOperation);
    const document = readRecastDocument(input);
    if (document.revision !== expectedRevision) {
        throw new Error("The conversion changed. Review this operation against the latest revision.");
    }

    if (document.journal.length >= RECAST_LIMITS.journal) {
        throw new Error(
            "Operation journal is full (10,000 entries). Save this conversion and start a new conversion to continue."
        );
    }

    const affected: string[] = [];
    switch (operation.kind) {
        case "add-source":
            document.sources.push(sourceSchema.parse(operation.source));
            break;
        case "add-anchor":
            document.anchors.push(anchorSchema.parse(operation.anchor));
            if (operation.reading) {
                document.readings.push(readingSchema.parse(operation.reading));
            }
            break;
        case "add-reading":
            document.readings.push(readingSchema.parse(operation.reading));
            break;
        case "capture":
            document.anchors.push(...operation.anchors.map((anchor) => anchorSchema.parse(anchor)));
            document.readings.push(...operation.readings.map((reading) => readingSchema.parse(reading)));
            for (const input of operation.records) {
                const record = recordSchema.parse(input);
                record.state = "draft";
                for (const cell of Object.values(record.cells)) {
                    cell.state = cell.value === null ? "unknown" : "proposed";
                    cell.origin = "source";
                }
                document.records.push(record);
                affected.push(record.id);
            }
            break;
        case "add-collection":
            document.collections.push(collectionSchema.parse(operation.collection));
            break;
        case "add-record": {
            const collection = document.collections.find((entry) => entry.id === operation.collectionId);
            if (!collection) {
                throw new Error("Choose an existing object collection.");
            }
            const record: RecastRecord = {
                id: operation.id ?? newRecastID("record"),
                collectionId: collection.id,
                state: "draft",
                createdAt: at,
                cells: Object.fromEntries(collection.fields.map((field) => [field.id, unknownCell()])),
            };
            document.records.push(record);
            affected.push(record.id);
            break;
        }
        case "add-proposals":
            for (const input of operation.records) {
                const record = recordSchema.parse(input);
                record.state = "draft";
                for (const cell of Object.values(record.cells)) {
                    cell.state = cell.value === null ? "unknown" : "proposed";
                    cell.origin = "inferred";
                }
                document.records.push(record);
                affected.push(record.id);
            }
            break;
        case "set-cell": {
            const record = ownedRecord(document, operation.recordId);
            if (record.state === "archived") {
                throw new Error("An archived record cannot change its fields.");
            }
            const collection = document.collections.find((entry) => entry.id === record.collectionId);
            const field = collection?.fields.find((entry) => entry.id === operation.fieldId);
            if (!field) {
                throw new Error("Choose an existing field.");
            }
            const cell = cellSchema.parse(operation.cell);
            const invalid = validateFieldValue(cell.value, { ...field, required: false });
            if (invalid) {
                throw new Error(invalid);
            }
            correction({ document, record, fieldId: field.id, cell, reason: operation.reason, at });
            affected.push(record.id);
            break;
        }
        case "set-evidence": {
            const record = ownedRecord(document, operation.recordId);
            const collection = document.collections.find((entry) => entry.id === record.collectionId);

            if (record.state === "archived") {
                throw new Error("An archived record cannot change its evidence.");
            }

            if (!collection?.fields.some((entry) => entry.id === operation.fieldId)) {
                throw new Error("Choose an existing field.");
            }

            const cell = structuredClone(record.cells[operation.fieldId] ?? unknownCell());
            cell.anchorIds = [...operation.anchorIds];
            cell.readingIds = [...operation.readingIds];
            correction({ document, record, fieldId: operation.fieldId, cell, reason: operation.reason, at });
            affected.push(record.id);
            break;
        }
        case "attach-anchor": {
            const record = ownedRecord(document, operation.recordId);

            if (record.state === "archived") {
                throw new Error("An archived record cannot change its evidence.");
            }

            const collection = document.collections.find((entry) => entry.id === record.collectionId);
            if (!collection?.fields.some((entry) => entry.id === operation.fieldId)) {
                throw new Error("Choose an existing field.");
            }
            if (!document.anchors.some((anchor) => anchor.id === operation.anchorId)) {
                throw new Error("Choose an existing source region.");
            }
            const cell = structuredClone(record.cells[operation.fieldId] ?? unknownCell());
            cell.anchorIds = [...new Set([...cell.anchorIds, operation.anchorId])];
            correction({
                document,
                record,
                fieldId: operation.fieldId,
                cell,
                reason: "Attached selected source region",
                at,
            });
            affected.push(record.id);
            break;
        }
        case "start-contradiction": {
            affected.push(...startContradiction({ document, operation, at }));
            break;
        }
        case "resolve-contradiction": {
            affected.push(...applyContradictionDecision({ document, operation, at }));
            break;
        }
        case "bulk-correct": {
            const collection = document.collections.find((entry) => entry.id === operation.collectionId);
            const field = collection?.fields.find((entry) => entry.id === operation.fieldId);
            if (!collection || !field || new Set(operation.recordIds).size !== operation.recordIds.length) {
                throw new Error("Choose an existing field and distinct records from this collection.");
            }
            const invalid = validateFieldValue(operation.value, { ...field, required: false });
            if (invalid) {
                throw new Error(invalid);
            }
            const records = operation.recordIds.map((id) => ownedRecord(document, id));
            if (records.some((record) => record.collectionId !== collection.id || record.state === "archived")) {
                throw new Error("Bulk correction requires active records in the same collection.");
            }
            requireCorrectionCapacity(document, records.length);
            for (const record of records) {
                const cell = structuredClone(record.cells[field.id] ?? unknownCell());
                cell.value = operation.value;
                cell.origin = "user";
                cell.note = operation.note;
                correction({ document, record, fieldId: field.id, cell, reason: operation.reason, at });
                affected.push(record.id);
            }
            break;
        }
        case "reuse-correction": {
            const record = ownedRecord(document, operation.recordId);
            const preview = previewCorrectionExamples({
                input: document,
                recordId: record.id,
                fieldId: operation.fieldId,
            });
            const example = preview.examples.find((entry) => entry.correctionId === operation.correctionId);
            if (!example) {
                throw new Error("This correction no longer matches the current field's source, regions and readings.");
            }
            const cell = structuredClone(record.cells[operation.fieldId] ?? unknownCell());
            cell.value = example.value;
            cell.origin = "inferred";
            cell.note = `Proposed from source-local correction ${example.correctionId}. Review against the current source.`;
            correction({ document, record, fieldId: operation.fieldId, cell, reason: operation.reason, at });
            affected.push(record.id);
            break;
        }
        case "accept-records": {
            const pendingAnchors = pendingReconciliationAnchors(document);
            for (const id of new Set(operation.recordIds)) {
                const record = ownedRecord(document, id);
                if (record.state === "archived") {
                    throw new Error("Restore an archived record before accepting it.");
                }
                const issues = recordIssues({ document, record, requireAccepted: false, pendingAnchors });
                if (issues.length) {
                    throw new Error(issues.map((issue) => issue.message).join("\n"));
                }
                for (const cell of Object.values(record.cells)) {
                    if (cell.value !== null) {
                        cell.state = "accepted";
                    }
                }
                record.state = "accepted";
                affected.push(id);
            }
            break;
        }
        case "archive-records":
            for (const id of new Set(operation.recordIds)) {
                ownedRecord(document, id).state = "archived";
                affected.push(id);
            }
            break;
        case "start-reconciliation": {
            const oldSource = document.sources.find((source) => source.id === operation.oldSourceId);
            const newSource = document.sources.find((source) => source.id === operation.newSourceId);
            if (!oldSource || !newSource || oldSource.id === newSource.id) {
                throw new Error("Choose two distinct source snapshots.");
            }
            if (
                (newSource.replaces && newSource.replaces !== oldSource.id) ||
                document.reconciliations.some(
                    (job) => job.oldSourceId === oldSource.id && job.items.some((item) => item.status === "pending")
                )
            ) {
                throw new Error("Finish the pending source review before starting another replacement.");
            }
            const anchors = activeSourceAnchors(document, oldSource.id);
            const ids = new Set(anchors.map((anchor) => anchor.id));
            newSource.replaces = oldSource.id;
            if (oldSource.contentHash === newSource.contentHash && oldSource.kind === newSource.kind) {
                const readings = document.readings.slice();
                for (const old of anchors) {
                    const next = { ...structuredClone(old), id: newRecastID("anchor"), sourceId: newSource.id };
                    document.anchors.push(next);
                    document.readings.push(
                        ...readings
                            .filter((reading) => reading.anchorId === old.id)
                            .map((reading) => ({
                                ...structuredClone(reading),
                                id: newRecastID("reading"),
                                anchorId: next.id,
                            }))
                    );
                }
            }
            document.reconciliations.push({
                id: operation.id ?? newRecastID("reconciliation"),
                oldSourceId: oldSource.id,
                newSourceId: newSource.id,
                createdAt: at,
                items: anchors.map((anchor) => ({ oldAnchorId: anchor.id, status: "pending" })),
            });
            for (const record of document.records.filter((entry) => entry.state !== "archived")) {
                for (const cell of Object.values(record.cells)) {
                    if (cell.anchorIds.some((id) => ids.has(id))) {
                        cell.state = cell.value === null ? "unknown" : "proposed";
                        record.state = "draft";
                        affected.push(record.id);
                    }
                }
            }
            break;
        }
        case "resolve-reconciliation": {
            const job = document.reconciliations.find((entry) => entry.id === operation.jobId);
            if (
                !job ||
                new Set(operation.resolutions.map((resolution) => resolution.oldAnchorId)).size !==
                    operation.resolutions.length
            ) {
                throw new Error("Choose unique pending regions from an existing source review.");
            }
            const readings = new Map(document.readings.map((reading) => [reading.id, reading]));
            for (const resolution of operation.resolutions) {
                const item = job.items.find((entry) => entry.oldAnchorId === resolution.oldAnchorId);
                if (item?.status !== "pending") {
                    throw new Error("This source region was already reviewed. Undo that decision before changing it.");
                }
                if (resolution.decision === "keep") {
                    if (resolution.newAnchorId) {
                        throw new Error("Keeping original evidence does not attach a replacement region.");
                    }
                    item.status = "kept";
                    continue;
                }
                const anchor = document.anchors.find((entry) => entry.id === resolution.newAnchorId);
                if (!anchor || anchor.sourceId !== job.newSourceId) {
                    throw new Error("Choose a region from the replacement source.");
                }
                const newReadings = document.readings
                    .filter((reading) => reading.anchorId === anchor.id)
                    .map((reading) => reading.id);
                for (const record of document.records.filter((entry) => entry.state !== "archived")) {
                    for (const [fieldId, before] of Object.entries(record.cells)) {
                        if (!before.anchorIds.includes(item.oldAnchorId)) {
                            continue;
                        }
                        const cell = structuredClone(before);
                        cell.anchorIds = [
                            ...new Set(cell.anchorIds.map((id) => (id === item.oldAnchorId ? anchor.id : id))),
                        ];
                        cell.readingIds = [
                            ...new Set([
                                ...cell.readingIds.filter((id) => readings.get(id)?.anchorId !== item.oldAnchorId),
                                ...newReadings,
                            ]),
                        ];
                        cell.state = cell.value === null ? "unknown" : "proposed";
                        correction({
                            document,
                            record,
                            fieldId,
                            cell,
                            at,
                            reason: "Reviewed replacement source. Retained the interpretation for verification.",
                        });
                        affected.push(record.id);
                    }
                }
                item.status = "relinked";
                item.newAnchorId = anchor.id;
            }
            break;
        }
        case "record-rendering": {
            const receipt = renderingReceiptSchema.parse(operation.receipt);
            if (document.renderings.some((entry) => entry.id === receipt.id)) {
                throw new Error("This export was already recorded.");
            }
            document.renderings = [...document.renderings, receipt].slice(-RECAST_LIMITS.renderings);
            break;
        }
        case "forget-rendering":
            if (!document.renderings.some((receipt) => receipt.id === operation.receiptId)) {
                throw new Error("Choose an existing export receipt.");
            }
            document.renderings = document.renderings.filter((receipt) => receipt.id !== operation.receiptId);
            break;
        case "apply-roundtrip": {
            const preview = previewRoundTrip({ input: document, receiptId: operation.receiptId, csv: operation.csv });
            const selected = new Set(operation.importChangeIds);
            if (
                selected.size !== operation.importChangeIds.length ||
                [...selected].some((id) => !preview.changes.some((change) => change.id === id))
            ) {
                throw new Error("Choose unique changes from the current CSV comparison.");
            }
            const changes = preview.changes.filter((entry) => selected.has(entry.id));
            requireCorrectionCapacity(document, changes.filter((entry) => entry.kind === "field").length);
            for (const change of changes) {
                const record = ownedRecord(document, change.recordId);
                if (change.status === "invalid") {
                    throw new Error(change.message);
                }
                if (change.kind === "archive") {
                    record.state = "archived";
                } else {
                    if (!change.fieldId || record.state === "archived") {
                        throw new Error("Restore an archived record before importing changes to its fields.");
                    }
                    const cell = structuredClone(record.cells[change.fieldId] ?? unknownCell());
                    cell.value = change.incoming;
                    cell.state = change.incoming === null ? "unknown" : "proposed";
                    cell.origin = "user";
                    cell.note = "Edited in CSV; preserved source evidence describes the original reading.";
                    correction({
                        document,
                        record,
                        fieldId: change.fieldId,
                        cell,
                        at,
                        reason: `Reviewed CSV edit from export ${operation.receiptId}`,
                    });
                }
                affected.push(record.id);
            }
            break;
        }
        case "rename":
            document.title = operation.title;
            break;
    }

    refreshContradictions(document);
    document.revision++;
    document.journal.push({
        id: newRecastID("operation"),
        revision: document.revision,
        at,
        action: operation.kind,
        recordIds: [...new Set(affected)],
    });
    return readRecastDocument(document);
}
