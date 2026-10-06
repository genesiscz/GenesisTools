import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { formatCSVCell } from "@genesiscz/utils/tabular/csv";
import { Temporal } from "@js-temporal/polyfill";
import {
    type CellValue,
    newRecastID,
    type RecastDocument,
    type RecastRecord,
    type RenderingReceipt,
    readRecastDocument,
} from "./document";
import { calendarInstant, pendingReconciliationAnchors, type RecastIssue, recordIssues } from "./validation";

export interface RecastRendering {
    format: "csv" | "markdown" | "json" | "ics";
    mime: string;
    text: string;
    contentHash: string;
    recordIds: string[];
    evidence: string;
    receipt: RenderingReceipt;
}

export class RecastExportError extends Error {
    constructor(readonly issues: RecastIssue[]) {
        super(issues.map((issue) => issue.message).join("\n"));
        this.name = "RecastExportError";
    }
}

function textValue(value: CellValue | undefined): string {
    return value == null ? "" : String(value);
}

function markdownText(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replace(/[\\\u0060*_[\]{}|]/g, "\\$&")
        .replace(/\r\n|\r|\n/g, "<br>");
}

function icalText(value: string): string {
    return value
        .replaceAll("\\", "\\\\")
        .replace(/\r\n|\r|\n/g, "\\n")
        .replaceAll(";", "\\;")
        .replaceAll(",", "\\,");
}

/** RFC 5545 content-line folding counts UTF-8 octets, including continuation whitespace. */
export function foldCalendarLine(line: string): string {
    const rows: string[] = [];
    let row = "";
    let bytes = 0;
    for (const character of line) {
        const length = Buffer.byteLength(character);
        if (bytes + length > 75) {
            rows.push(row);
            row = " ";
            bytes = 1;
        }
        row += character;
        bytes += length;
    }
    rows.push(row);
    return rows.join("\r\n");
}

function calendarStamp(instant: Temporal.Instant): string {
    const stamp = instant.toString({ smallestUnit: "second" });
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(stamp)) {
        throw new Error("Calendar timestamps must stay in years 0001–9999.");
    }
    return stamp.replace(/[-:]/g, "");
}

function evidenceReport(document: RecastDocument, records: RecastRecord[]): string {
    return SafeJSON.stringify(
        {
            format: "genesis-recast-evidence",
            version: 1,
            documentId: document.id,
            revision: document.revision,
            collections: document.collections.filter((collection) =>
                records.some((record) => record.collectionId === collection.id)
            ),
            contradictions: document.contradictions.filter((review) =>
                review.members.some((member) => records.some((record) => record.id === member.recordId))
            ),
            records: records.map((record) => ({
                id: record.id,
                collectionId: record.collectionId,
                fields: Object.fromEntries(
                    Object.entries(record.cells).map(([field, cell]) => [
                        field,
                        {
                            value: cell.value,
                            state: cell.state,
                            origin: cell.origin,
                            note: cell.note,
                            alternatives: cell.alternatives,
                            evidence: cell.anchorIds.map((id) => {
                                const anchor = document.anchors.find((entry) => entry.id === id)!;
                                const source = document.sources.find((entry) => entry.id === anchor.sourceId)!;
                                return {
                                    source: source.name,
                                    sourceHash: source.contentHash,
                                    anchorId: id,
                                    region: anchor.region,
                                    literalReadings: document.readings.filter(
                                        (reading) => cell.readingIds.includes(reading.id) && reading.anchorId === id
                                    ),
                                };
                            }),
                        },
                    ])
                ),
            })),
        },
        null,
        2
    );
}

export function renderRecastCollection({
    input,
    collectionId,
    format,
    recordIds,
    at = new Date().toISOString(),
    includeRecordIds = true,
}: {
    input: unknown;
    collectionId: string;
    format: RecastRendering["format"];
    recordIds?: string[];
    at?: string;
    includeRecordIds?: boolean;
}): RecastRendering {
    const document = readRecastDocument(input);
    const collection = document.collections.find((entry) => entry.id === collectionId);
    if (!collection) {
        throw new Error("Choose an existing object collection.");
    }
    const requested = recordIds ? new Set(recordIds) : undefined;
    const records = document.records.filter(
        (record) =>
            record.collectionId === collectionId &&
            record.state !== "archived" &&
            (!requested || requested.has(record.id))
    );

    if (records.length === 0 || (requested && requested.size !== records.length)) {
        throw new Error("Choose at least one existing, active record in this collection.");
    }

    const pendingAnchors = pendingReconciliationAnchors(document);
    const issues = records.flatMap((record) => recordIssues({ document, record, pendingAnchors }));
    if (issues.length) {
        throw new RecastExportError(issues);
    }

    let text: string;
    let mime: string;
    if (format === "csv") {
        const columns = [
            ...(includeRecordIds ? ["__recast_record_id"] : []),
            ...collection.fields.map((field) => field.id),
        ];
        const rows = [columns.map((value) => formatCSVCell({ value })).join(",")];
        for (const record of records) {
            rows.push(
                [
                    ...(includeRecordIds ? [formatCSVCell({ value: record.id })] : []),
                    ...collection.fields.map((field) => {
                        const value = record.cells[field.id]?.value;
                        return formatCSVCell({ value: typeof value === "number" ? value : textValue(value) });
                    }),
                ].join(",")
            );
        }
        text = `${rows.join("\r\n")}\r\n`;
        mime = "text/csv";
    } else if (format === "json") {
        text = `${SafeJSON.stringify(
            records.map((record) =>
                Object.fromEntries(collection.fields.map((field) => [field.id, record.cells[field.id]?.value ?? null]))
            ),
            null,
            2
        )}\n`;
        mime = "application/json";
    } else if (format === "markdown") {
        const rows = [`# ${markdownText(collection.label)}`, ""];
        if (collection.kind === "checklist") {
            for (const record of records) {
                rows.push(
                    `- [${record.cells.done?.value === true ? "x" : " "}] ${markdownText(textValue(record.cells.title?.value))}`
                );
                const notes = textValue(record.cells.notes?.value);
                if (notes) {
                    rows.push(`  ${markdownText(notes)}`);
                }
            }
        } else {
            rows.push(
                `| ${collection.fields.map((field) => markdownText(field.label)).join(" | ")} |`,
                `| ${collection.fields.map(() => "---").join(" | ")} |`,
                ...records.map(
                    (record) =>
                        `| ${collection.fields.map((field) => markdownText(textValue(record.cells[field.id]?.value))).join(" | ")} |`
                )
            );
        }
        text = `${rows.join("\n")}\n`;
        mime = "text/markdown";
    } else if (format === "ics") {
        if (collection.kind !== "calendar") {
            throw new Error("ICS needs a calendar-event collection.");
        }
        const stamp = calendarStamp(Temporal.Instant.from(at));
        const rows = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GenesisTools//Recast//EN", "CALSCALE:GREGORIAN"];
        for (const record of records) {
            const zone = textValue(record.cells.timezone?.value);
            rows.push(
                "BEGIN:VEVENT",
                `UID:${record.id}@recast.local`,
                `DTSTAMP:${stamp}`,
                `SEQUENCE:${document.revision}`,
                `DTSTART:${calendarStamp(calendarInstant(textValue(record.cells.start?.value), zone))}`,
                `DTEND:${calendarStamp(calendarInstant(textValue(record.cells.end?.value), zone))}`,
                `SUMMARY:${icalText(textValue(record.cells.title?.value))}`
            );
            const location = textValue(record.cells.location?.value);
            const notes = textValue(record.cells.notes?.value);
            if (location) {
                rows.push(`LOCATION:${icalText(location)}`);
            }
            if (notes) {
                rows.push(`DESCRIPTION:${icalText(notes)}`);
            }
            rows.push("END:VEVENT");
        }
        rows.push("END:VCALENDAR");
        text = `${rows.map(foldCalendarLine).join("\r\n")}\r\n`;
        mime = "text/calendar";
    } else {
        throw new Error("Choose CSV, Markdown, JSON or ICS.");
    }

    return {
        format,
        mime,
        text,
        contentHash: createHash("sha256").update(text).digest("hex"),
        recordIds: records.map((record) => record.id),
        evidence: evidenceReport(document, records),
        receipt: {
            id: newRecastID("rendering"),
            documentId: document.id,
            revision: document.revision,
            collectionId,
            format,
            createdAt: at,
            includeRecordIds,
            contentHash: createHash("sha256").update(text).digest("hex"),
            fields: structuredClone(collection.fields),
            rows: records.map((record) => ({
                id: record.id,
                values: Object.fromEntries(
                    collection.fields.map((field) => [field.id, record.cells[field.id]?.value ?? null])
                ),
            })),
        },
    };
}
