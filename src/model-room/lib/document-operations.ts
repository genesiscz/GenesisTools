import { convertValue, parseUnit, requireSameDimension } from "@genesiscz/utils/quantities/units";
import { compileModel } from "./compiler";
import { type ModelDocument, readModelDocument } from "./document";

export function convertModelTime({ input, unit }: { input: unknown; unit: string }): ModelDocument {
    const original = readModelDocument(input);
    const from = parseUnit({ source: original.time.unit });
    const to = parseUnit({ source: unit });
    requireSameDimension(from, parseUnit({ source: "s" }));
    requireSameDimension(from, to);
    const convert = (value: number) => convertValue({ value, from, to });
    const document = structuredClone(original);
    document.time = { unit, duration: convert(original.time.duration), step: convert(original.time.step) };
    for (const quantity of [
        ...document.quantities,
        ...document.scenarios.flatMap((scenario) => scenario.replacements),
    ]) {
        if (quantity.kind === "data") {
            quantity.points = quantity.points.map((point) => ({ ...point, time: convert(point.time) }));
        }
    }

    for (const scenario of document.scenarios) {
        for (const intervention of scenario.interventions) {
            intervention.at = convert(intervention.at);
        }
    }

    for (const step of document.presentation.steps) {
        if (step.time !== undefined) {
            step.time = convert(step.time);
        }
    }

    compileModel({ input: document });
    for (const scenario of document.scenarios) {
        compileModel({ input: document, scenarioId: scenario.id });
    }

    return document;
}
