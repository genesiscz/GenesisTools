import { formatCSVCell } from "@genesiscz/utils/tabular/csv";
import { parseDelimited } from "@genesiscz/utils/tabular/delimited";
import { type CellValue, type RecastCollection, readRecastDocument } from "./document";
import { validateFieldValue } from "./validation";

export interface RoundTripChange {
    id: string;
    kind: "field" | "archive";
    status: "change" | "conflict" | "invalid";
    recordId: string;
    fieldId?: string;
    label: string;
    base: CellValue;
    current: CellValue;
    incoming: CellValue;
    message: string;
}

function exportedCell(value: CellValue): string {
    const formatted = formatCSVCell({ value: typeof value === "number" ? value : value === null ? "" : String(value) });
    // Decode the exact exported cell, including CSV formula protection, without guessing how
    // a spreadsheet displays it. An unchanged protected formula is still the original value.
    return parseDelimited({ source: `value\n${formatted}\n` }).rows[0]?.[0] ?? "";
}

function importCell(text: string, field: RecastCollection["fields"][number]): CellValue {
    if (text === "") {
        return null;
    }
    if (field.type === "number") {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) {
            throw new Error("Enter a number without a thousands separator.");
        }
        const value = Number(text);
        if (!Number.isFinite(value)) {
            throw new Error("Enter a finite number.");
        }
        return value;
    }
    if (field.type === "boolean") {
        if (!["true", "false"].includes(text.toLowerCase())) {
            throw new Error("Use true or false.");
        }
        return text.toLowerCase() === "true";
    }
    if (text.length > 8000) {
        throw new Error("A field may not exceed 8,000 characters.");
    }
    return text;
}

export function previewRoundTrip({ input, receiptId, csv }: { input: unknown; receiptId: string; csv: string }) {
    const document = readRecastDocument(input);
    const receipt = document.renderings.find((entry) => entry.id === receiptId);
    if (receipt?.format !== "csv" || !receipt.includeRecordIds) {
        throw new Error("Choose a saved CSV export that includes stable row IDs.");
    }
    const collection = document.collections.find((entry) => entry.id === receipt.collectionId);
    if (
        !collection ||
        receipt.fields.some(
            (field) => !collection.fields.some((current) => current.id === field.id && current.type === field.type)
        )
    ) {
        throw new Error("The collection's fields changed. Export a new CSV before round-trip editing.");
    }
    const table = parseDelimited({ source: csv, maxRows: 2000 });
    const required = ["__recast_record_id", ...receipt.fields.map((field) => field.id)];
    if (required.length !== table.headers.length || required.some((key) => !table.headers.includes(key))) {
        throw new Error("Keep the exported header names and the __recast_record_id column. Column order may change.");
    }
    const idColumn = table.headers.indexOf("__recast_record_id");
    const received = new Map<string, string[]>();
    const exported = new Map(receipt.rows.map((row) => [row.id, row]));
    for (const row of table.rows) {
        const id = row[idColumn];
        if (!exported.has(id) || received.has(id)) {
            throw new Error("The CSV has an unknown or repeated row ID. Add new records inside Recast.");
        }
        received.set(id, row);
    }
    const records = new Map(document.records.map((record) => [record.id, record]));
    const changes: RoundTripChange[] = [];
    let unchanged = 0;
    for (const before of receipt.rows) {
        const record = records.get(before.id);
        if (!record || record.collectionId !== receipt.collectionId) {
            throw new Error("An exported record is no longer available.");
        }
        const row = received.get(before.id);
        if (!row) {
            if (record.state === "archived") {
                continue;
            }
            const changedLocally = receipt.fields.some(
                (field) => (record.cells[field.id]?.value ?? null) !== before.values[field.id]
            );
            changes.push({
                id: `${before.id}:archive`,
                kind: "archive",
                recordId: before.id,
                label: String(record.cells[receipt.fields[0].id]?.value ?? before.id),
                status: changedLocally ? "conflict" : "change",
                base: null,
                current: null,
                incoming: null,
                message: changedLocally
                    ? "Missing from CSV, but this record also changed in Recast. Choose whether to archive it."
                    : "Missing from CSV. Apply to archive this record; its evidence and corrections remain recoverable.",
            });
            continue;
        }
        for (const field of receipt.fields) {
            const base = before.values[field.id];
            const current = record.cells[field.id]?.value ?? null;
            const raw = row[table.headers.indexOf(field.id)];
            if (raw === exportedCell(base)) {
                unchanged++;
                continue;
            }
            let incoming: CellValue;
            let issue: string | undefined;
            try {
                incoming = importCell(raw, field);
                issue = validateFieldValue(incoming, { ...field, required: false });
            } catch (error) {
                incoming = raw.length <= 8000 ? raw : null;
                issue = error instanceof Error ? error.message : String(error);
            }
            if (!issue && incoming === current && record.state !== "archived") {
                unchanged++;
                continue;
            }
            const conflict = current !== base || record.state === "archived";
            changes.push({
                id: `${before.id}:${field.id}`,
                kind: "field",
                recordId: before.id,
                fieldId: field.id,
                label: field.label,
                base,
                current,
                incoming,
                status: issue || record.state === "archived" ? "invalid" : conflict ? "conflict" : "change",
                message:
                    issue ??
                    (record.state === "archived"
                        ? "This record is archived. Restore it before importing field changes."
                        : conflict
                          ? "Both the CSV and Recast changed this field. Choose which value to keep."
                          : "CSV edit becomes a user-supplied draft; the original source reading stays unchanged."),
            });
        }
    }
    return {
        documentId: document.id,
        revision: document.revision,
        receiptId,
        collectionId: receipt.collectionId,
        changes,
        unchanged,
        importedRows: table.rows.length,
    };
}
