import { SafeJSON } from "@genesiscz/utils/json";
import { formatCSVCell } from "@genesiscz/utils/tabular/csv";
import { type ModelDocument, readModelDocument, scenarioDocument } from "./document";
import type { EvaluatedScenario } from "./evaluation";

function csvCell(value: string | number): string {
    return formatCSVCell({ value, alwaysQuote: true });
}

export function resultsCSV(document: ModelDocument, scenarios: EvaluatedScenario[]): string {
    const columns = new Map(document.quantities.map((quantity) => [`${quantity.id}\0${quantity.unit}`, quantity]));
    const branches = scenarios
        .filter((scenario) => scenario.result)
        .map((scenario) => {
            const effective = scenarioDocument(document, scenario.id ?? undefined).document;
            for (const quantity of effective.quantities) {
                const key = `${quantity.id}\0${quantity.unit}`;

                if (!columns.has(key)) {
                    columns.set(key, quantity);
                }
            }

            return { scenario, units: new Map(effective.quantities.map((quantity) => [quantity.id, quantity.unit])) };
        });
    const quantities = [...columns.values()];
    const rows: (string | number)[][] = [
        [
            "Scenario",
            `Time (${document.time.unit})`,
            ...quantities.map((quantity) => `${quantity.label} (${quantity.unit}) [${quantity.id}]`),
        ],
    ];
    for (const { scenario, units } of branches) {
        for (const frame of scenario.result?.frames ?? []) {
            rows.push([
                scenario.label,
                frame.time,
                ...quantities.map(({ id, unit }) => (units.get(id) === unit ? (frame.values[id] ?? "") : "")),
            ]);
        }
    }

    return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function assumptionsCSV(document: ModelDocument): string {
    const rows: (string | number)[][] = [
        ["Identifier", "Name", "Kind", "Value or formula", "Unit", "Provenance", "Description"],
    ];
    for (const quantity of document.quantities) {
        const value =
            quantity.kind === "input"
                ? quantity.value
                : quantity.kind === "stock"
                  ? quantity.initial
                  : quantity.kind === "formula"
                    ? quantity.expression
                    : quantity.source;
        rows.push([
            quantity.id,
            quantity.label,
            quantity.kind,
            value,
            quantity.unit,
            quantity.provenance,
            quantity.description,
        ]);
    }

    return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function serializedModel(input: unknown): string {
    return SafeJSON.stringify(readModelDocument(input), { strict: true }, 2);
}

export function scriptJSON(input: unknown): string {
    return SafeJSON.stringify(input, { strict: true })
        .replaceAll("<", "\\u003c")
        .replaceAll("\u2028", "\\u2028")
        .replaceAll("\u2029", "\\u2029");
}
