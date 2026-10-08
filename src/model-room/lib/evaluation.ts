import { compileModel } from "./compiler";
import { readModelDocument } from "./document";
import { type RunControl, type SimulationResult, simulateAsync } from "./simulation";

export interface EvaluatedScenario {
    id: string | null;
    label: string;
    color: string;
    result?: SimulationResult;
    error?: string;
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
    scenarios.push({ id: null, label: "Baseline", color: "#a9c9ff", result: results });
    for (const scenario of document.scenarios) {
        try {
            const result = await simulateAsync({
                model: compileModel({ input: document, scenarioId: scenario.id }),
                control: runControl,
            });
            scenarios.push({ id: scenario.id, label: scenario.label, color: scenario.color, result });
        } catch (error) {
            if (runControl.signal?.aborted || (runControl.now?.() ?? performance.now()) >= runControl.deadline) {
                throw error;
            }

            scenarios.push({
                id: scenario.id,
                label: scenario.label,
                color: scenario.color,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const relationships = [...baseline.quantities].flatMap(([target, entry]) => [
        ...[...entry.references.immediate]
            .filter((id) => baseline.quantities.has(id))
            .map((source) => ({ source, target, delayed: false })),
        ...[...entry.references.delayed].map((source) => ({ source, target, delayed: true })),
    ]);
    return { document, scenarios, relationships };
}
