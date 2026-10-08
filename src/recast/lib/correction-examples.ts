import { SafeJSON } from "@genesiscz/utils/json";
import { type CellValue, type RecastAnchor, type RecastRegion, readRecastDocument } from "./document";
import { validateFieldValue } from "./validation";

function normalized(value: string): string {
    return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function excerpt(value: string): string {
    const characters = Array.from(value);
    return characters.length > 500 ? characters.slice(0, 500).join("") + "…" : value;
}

function sameRegion(a: RecastRegion, b: RecastRegion): boolean {
    if (a.kind === "text" && b.kind === "text") {
        return (
            normalized(a.quote) === normalized(b.quote) &&
            ((a.start === b.start && a.end === b.end) ||
                (Boolean(a.prefix || a.suffix) &&
                    normalized(a.prefix ?? "") === normalized(b.prefix ?? "") &&
                    normalized(a.suffix ?? "") === normalized(b.suffix ?? "")))
        );
    }

    if (a.kind === "rect" && b.kind === "rect" && a.page === b.page) {
        const intersection =
            Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
            Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        return intersection / (a.width * a.height + b.width * b.height - intersection) >= 0.8;
    }

    if (a.kind === "audio" && b.kind === "audio") {
        const intersection = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
        return intersection / (Math.max(a.endMs, b.endMs) - Math.min(a.startMs, b.startMs)) >= 0.8;
    }

    return false;
}

export interface RecastCorrectionExample {
    correctionId: string;
    value: CellValue;
    previousValue: CellValue;
    reason: string;
    sourceNames: string[];
    previousReadings: string[];
    currentReadings: string[];
}

export function previewCorrectionExamples({
    input,
    recordId,
    fieldId,
}: {
    input: unknown;
    recordId: string;
    fieldId: string;
}) {
    const document = readRecastDocument(input);
    const records = new Map(document.records.map((record) => [record.id, record]));
    const collections = new Map(document.collections.map((collection) => [collection.id, collection]));
    const anchors = new Map(document.anchors.map((anchor) => [anchor.id, anchor]));
    const sources = new Map(document.sources.map((source) => [source.id, source]));
    const readings = new Map(document.readings.map((reading) => [reading.id, reading]));
    const text = new Map(document.readings.map((reading) => [reading.id, normalized(reading.text)]));
    const record = records.get(recordId),
        collection = record && collections.get(record.collectionId);
    const field = collection?.fields.find((entry) => entry.id === fieldId);
    if (!record || record.state === "archived" || !collection || !field) {
        throw new Error("Choose an active record and existing field.");
    }

    const cell = record.cells[fieldId];
    const currentAnchors = cell?.anchorIds.map((id) => anchors.get(id)!) ?? [];
    const currentReadings = cell?.readingIds.map((id) => readings.get(id)!) ?? [];
    const sameAnchor = (old: RecastAnchor, next: RecastAnchor) =>
        old.sourceHash === next.sourceHash &&
        sources.get(old.sourceId)?.kind === sources.get(next.sourceId)?.kind &&
        sameRegion(old.region, next.region);
    const examples: RecastCorrectionExample[] = [];
    let previewBytes = 0;
    if (currentAnchors.length && currentReadings.length) {
        for (const correction of [...document.corrections].reverse()) {
            const oldRecord = records.get(correction.recordId);
            const oldCollection = oldRecord && collections.get(oldRecord.collectionId);
            const oldField = oldCollection?.fields.find((entry) => entry.id === correction.fieldId);
            if (
                correction.after.origin !== "user" ||
                correction.after.value === null ||
                correction.before.value === correction.after.value ||
                correction.after.value === cell?.value ||
                oldCollection?.kind !== collection.kind ||
                oldField?.type !== field.type ||
                normalized(oldField.label) !== normalized(field.label) ||
                validateFieldValue(correction.after.value, { ...field, required: false }) ||
                !correction.after.readingIds.length ||
                !correction.after.anchorIds.length
            ) {
                continue;
            }

            const oldAnchors = correction.after.anchorIds.map((id) => anchors.get(id)!);
            const oldReadings = correction.after.readingIds.map((id) => readings.get(id)!);
            if (
                !oldAnchors.every((old) => currentAnchors.some((next) => sameAnchor(old, next))) ||
                !oldReadings.every((old) =>
                    currentReadings.some(
                        (next) =>
                            text.get(old.id) === text.get(next.id) &&
                            sameAnchor(anchors.get(old.anchorId)!, anchors.get(next.anchorId)!)
                    )
                )
            ) {
                continue;
            }

            const example: RecastCorrectionExample = {
                correctionId: correction.id,
                value: correction.after.value,
                previousValue: correction.before.value,
                reason: correction.reason,
                sourceNames: [...new Set(oldAnchors.map((anchor) => sources.get(anchor.sourceId)!.name))],
                previousReadings: oldReadings.map((reading) => excerpt(reading.text)),
                currentReadings: currentReadings.map((reading) => excerpt(reading.text)),
            };
            previewBytes += Buffer.byteLength(SafeJSON.stringify(example, { strict: true }));
            if (previewBytes > 512 * 1024) {
                break;
            }
            examples.push(example);
            if (examples.length === 64) {
                break;
            }
        }
    }

    return {
        documentId: document.id,
        revision: document.revision,
        recordId,
        fieldId,
        fieldLabel: field.label,
        examples,
    };
}
