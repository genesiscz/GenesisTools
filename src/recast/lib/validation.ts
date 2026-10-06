import { Temporal } from "@js-temporal/polyfill";
import type { CellValue, RecastCollection, RecastDocument, RecastRecord } from "./document";

export function pendingReconciliationAnchors(document: RecastDocument): ReadonlySet<string> {
    return new Set(
        document.reconciliations.flatMap((job) =>
            job.items.filter((item) => item.status === "pending").map((item) => item.oldAnchorId)
        )
    );
}

export interface RecastIssue {
    recordId: string;
    fieldId?: string;
    code: "missing" | "type" | "unreviewed" | "evidence" | "time";
    message: string;
}

export function validateFieldValue(value: CellValue, field: RecastCollection["fields"][number]): string | undefined {
    if (value === null || (typeof value === "string" && !value.trim())) {
        return field.required ? `${field.label} is required.` : undefined;
    }

    if (field.type === "number") {
        return typeof value === "number" && Number.isFinite(value)
            ? undefined
            : `${field.label} needs a finite number.`;
    }

    if (field.type === "boolean") {
        return typeof value === "boolean" ? undefined : `${field.label} needs true or false.`;
    }

    if (typeof value !== "string") {
        return `${field.label} needs text.`;
    }

    try {
        if (field.type === "date") {
            if (
                !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ||
                Temporal.PlainDate.from(value, { overflow: "reject" }).year < 1
            ) {
                throw new Error("date");
            }
        } else if (field.type === "datetime") {
            if (
                !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:Z|[+-][0-9]{2}:[0-9]{2})?$/.test(value)
            ) {
                throw new Error("datetime");
            }
            const local = value.replace(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/, "");
            if (Temporal.PlainDateTime.from(local, { overflow: "reject" }).year < 1) {
                throw new Error("datetime");
            }
        } else if (field.type === "timezone") {
            if (value !== "UTC" && !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) {
                throw new Error("timezone");
            }
            new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
        }
    } catch {
        return field.type === "timezone"
            ? "Choose an IANA time zone such as Europe/Prague or UTC."
            : `${field.label} is not a valid ${field.type === "date" ? "YYYY-MM-DD date." : "YYYY-MM-DDTHH:mm date and time."}`;
    }

    return undefined;
}

export function calendarInstant(local: string, timezone: string): Temporal.Instant {
    const zoned = Temporal.ZonedDateTime.from(`${local}[${timezone}]`, {
        disambiguation: "reject",
        offset: "reject",
        overflow: "reject",
    });
    const instant = zoned.toInstant();
    const year = instant.toZonedDateTimeISO("UTC").year;

    if (year < 1 || year > 9999) {
        throw new Error("Calendar exports support years 0001 through 9999.");
    }

    return instant;
}

export function recordIssues({
    document,
    record,
    requireAccepted = true,
    pendingAnchors = pendingReconciliationAnchors(document),
}: {
    document: RecastDocument;
    record: RecastRecord;
    requireAccepted?: boolean;
    pendingAnchors?: ReadonlySet<string>;
}): RecastIssue[] {
    const collection = document.collections.find((entry) => entry.id === record.collectionId);
    if (!collection) {
        return [{ recordId: record.id, code: "type", message: "The record's collection is missing." }];
    }

    const issues: RecastIssue[] = [];
    for (const review of document.contradictions) {
        if (review.status === "pending" && review.members.some((member) => member.recordId === record.id)) {
            issues.push({
                recordId: record.id,
                fieldId: review.fieldId,
                code: "evidence",
                message: "Resolve competing evidence: " + review.label,
            });
        }
    }

    for (const field of collection.fields) {
        const cell = record.cells[field.id];
        if (cell?.anchorIds.some((id) => pendingAnchors.has(id))) {
            issues.push({
                recordId: record.id,
                fieldId: field.id,
                code: "evidence",
                message: "Review this field's replaced source, or explicitly keep its original evidence.",
            });
        }
        const issue = validateFieldValue(cell?.value ?? null, field);
        if (issue) {
            issues.push({
                recordId: record.id,
                fieldId: field.id,
                code: cell?.value == null ? "missing" : "type",
                message: issue,
            });
        }

        if (cell?.value != null) {
            if (requireAccepted && cell.state !== "accepted") {
                issues.push({
                    recordId: record.id,
                    fieldId: field.id,
                    code: "unreviewed",
                    message: `${field.label} has not been accepted.`,
                });
            }

            if (cell.origin !== "user") {
                const anchors = cell.anchorIds.map((id) => document.anchors.find((anchor) => anchor.id === id));
                if (
                    anchors.length === 0 ||
                    anchors.some(
                        (anchor) =>
                            !anchor ||
                            anchor.region.kind === "whole" ||
                            document.sources.find((source) => source.id === anchor.sourceId)?.kind === "unsupported"
                    )
                ) {
                    issues.push({
                        recordId: record.id,
                        fieldId: field.id,
                        code: "evidence",
                        message: `${field.label} needs a specific readable source region, or an explicit user-supplied value.`,
                    });
                }
            }
        }
    }

    if (requireAccepted && record.state !== "accepted") {
        issues.push({ recordId: record.id, code: "unreviewed", message: "Accept this record before export." });
    }

    if (collection.kind === "calendar" && !issues.some((issue) => ["missing", "type"].includes(issue.code))) {
        try {
            const start = record.cells.start?.value;
            const end = record.cells.end?.value;
            const zone = record.cells.timezone?.value;

            if (typeof start !== "string" || typeof end !== "string" || typeof zone !== "string") {
                throw new Error("Missing calendar fields.");
            }

            if (Temporal.Instant.compare(calendarInstant(start, zone), calendarInstant(end, zone)) >= 0) {
                throw new Error("The end must be after the start.");
            }
        } catch (error) {
            issues.push({
                recordId: record.id,
                code: "time",
                message:
                    "Calendar time needs review: " +
                    (error instanceof Error ? error.message : String(error)) +
                    " Repeated or skipped local times require an explicit valid offset.",
            });
        }
    }

    return issues;
}
