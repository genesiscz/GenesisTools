import { parseDelimited } from "@genesiscz/utils/tabular/delimited";
import { compileModel } from "./compiler";
import { type ModelDocument, readModelDocument } from "./document";

export async function verifyObservationDigest({
    text,
    expectedDigest,
}: {
    text: string;
    expectedDigest?: string;
}): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");

    if (expectedDigest !== undefined && expectedDigest !== sha256) {
        throw new Error("The observation file changed after its preview. Reload the preview and review the mapping.");
    }

    return sha256;
}

export interface ObservationMapping {
    timeColumn: string;
    valueColumn: string;
    delimiter: "," | ";" | "\t";
    interpolation: "hold" | "linear";
    decimalSeparator: "." | ",";
}

export function previewObservationTable({ text, delimiter = "," }: { text: string; delimiter?: "," | ";" | "\t" }) {
    const table = parseDelimited({ source: text, delimiter });
    return { headers: table.headers, preview: table.rows.slice(0, 12), rowCount: table.rows.length };
}

export function importObservationQuantity({
    document,
    text,
    mapping,
    id,
    label,
    unit,
    sourceName,
}: {
    document: ModelDocument;
    text: string;
    mapping: ObservationMapping;
    id: string;
    label: string;
    unit: string;
    sourceName: string;
}): ModelDocument {
    const table = parseDelimited({ source: text, delimiter: mapping.delimiter });
    const timeIndex = table.headers.indexOf(mapping.timeColumn);
    const valueIndex = table.headers.indexOf(mapping.valueColumn);

    if (timeIndex < 0 || valueIndex < 0 || timeIndex === valueIndex) {
        throw new Error("Choose two different existing columns for time and value.");
    }

    if (document.quantities.some((quantity) => quantity.id === id)) {
        throw new Error(`The quantity identifier “${id}” is already in use.`);
    }

    const numeric = (text: string, row: number, column: string): number => {
        const normalized = mapping.decimalSeparator === "," ? text.trim().replaceAll(",", ".") : text.trim();

        if (
            !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized) ||
            !Number.isFinite(Number(normalized))
        ) {
            throw new Error(
                `Data row ${row}, column “${column}”: “${text.slice(0, 80)}” is not a finite number. Choose the decimal separator explicitly.`
            );
        }

        return Number(normalized);
    };
    const points = table.rows.map((row, index) => ({
        time: numeric(row[timeIndex], index + 1, mapping.timeColumn),
        value: numeric(row[valueIndex], index + 1, mapping.valueColumn),
    }));
    const next = readModelDocument({
        ...document,
        quantities: [
            ...document.quantities,
            {
                id,
                label,
                unit,
                kind: "data",
                points,
                interpolation: mapping.interpolation,
                source: sourceName,
                description: `Time: ${mapping.timeColumn} (${document.time.unit}); value: ${mapping.valueColumn} (${unit}). Endpoint values are held outside the measured interval.`,
                provenance: "measured",
                position: {
                    x: 40 + (document.quantities.length % 12) * 240,
                    y: 40 + Math.floor(document.quantities.length / 12) * 160,
                },
            },
        ],
    });
    compileModel({ input: next });
    return next;
}
