import { SafeJSON } from "@genesiscz/utils/json";
import { type CompiledModel, compileModel } from "./compiler";
import { readModelDocument } from "./document";
import { type RunControl, type SimulationResult, simulateAsync } from "./simulation";

export interface EvaluatedQuantity {
    id: string;
    label: string;
    kind: string;
    unit: string;
    scale: number;
    dimension: string;
}

export interface EvaluatedRelationship {
    source: string;
    target: string;
    delayed: boolean;
}

export interface EvaluatedScenario {
    id: string | null;
    label: string;
    color: string;
    quantities: Record<string, EvaluatedQuantity>;
    relationships: EvaluatedRelationship[];
    result?: SimulationResult;
    error?: string;
}

function describeModel(model: CompiledModel) {
    const quantities = Object.fromEntries(
        [...model.quantities].map(([id, entry]) => [
            id,
            {
                id,
                label: entry.quantity.label,
                kind: entry.quantity.kind,
                unit: entry.quantity.unit,
                scale: entry.unit.scale,
                dimension: SafeJSON.stringify(
                    [...entry.unit.dimensions].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
                    { strict: true }
                ),
            },
        ])
    );
    const relationships = [...model.quantities].flatMap(([target, entry]) => [
        ...[...entry.references.immediate]
            .filter((id) => model.quantities.has(id))
            .map((source) => ({ source, target, delayed: false })),
        ...[...entry.references.delayed].map((source) => ({ source, target, delayed: true })),
    ]);
    return { quantities, relationships };
}

export function comparisonValue({
    value,
    source,
    target,
}: {
    value: number | undefined;
    source: EvaluatedQuantity | undefined;
    target: EvaluatedQuantity | undefined;
}): number | undefined {
    if (value === undefined || !source || !target || source.dimension !== target.dimension) {
        return undefined;
    }

    const converted = (value * source.scale) / target.scale;
    return Number.isFinite(converted) ? converted : undefined;
}

export async function evaluateDocument({ input, control = {} }: { input: unknown; control?: RunControl }) {
    const document = readModelDocument(input);
    const baseline = compileModel({ input: document });
    let totalQuantities = baseline.quantities.size;
    for (const scenario of document.scenarios) {
        const ids = new Set(document.quantities.map((quantity) => quantity.id));
        for (const quantity of scenario.replacements) {
            ids.add(quantity.id);
        }

        for (const id of scenario.removed) {
            ids.delete(id);
        }

        totalQuantities += ids.size;
    }

    const cells = (baseline.steps + 1) * totalQuantities;

    if (cells > 2_000_000) {
        throw new Error(
            "The scenario comparison exceeds two million result values. Reduce its steps, quantities or scenarios."
        );
    }
    const scenarios: EvaluatedScenario[] = [];
    const runControl = { ...control, deadline: control.deadline ?? (control.now?.() ?? performance.now()) + 20000 };
    const results = await simulateAsync({ model: baseline, control: runControl });
    scenarios.push({ id: null, label: "Baseline", color: "#a9c9ff", result: results, ...describeModel(baseline) });
    for (const scenario of document.scenarios) {
        try {
            const compiled = compileModel({ input: document, scenarioId: scenario.id });
            const result = await simulateAsync({ model: compiled, control: runControl });
            scenarios.push({
                id: scenario.id,
                label: scenario.label,
                color: scenario.color,
                result,
                ...describeModel(compiled),
            });
        } catch (error) {
            if (runControl.signal?.aborted || (runControl.now?.() ?? performance.now()) >= runControl.deadline) {
                throw error;
            }

            scenarios.push({
                id: scenario.id,
                label: scenario.label,
                color: scenario.color,
                quantities: {},
                relationships: [],
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const relationships = scenarios[0].relationships;
    return { document, scenarios, relationships };
}
