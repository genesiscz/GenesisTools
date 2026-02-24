// src/automate/lib/steps/parallel.ts

import type { StepContext } from "@app/automate/lib/registry";
import { registerStepCatalog, registerStepHandler, resolveStepHandler } from "@app/automate/lib/registry";
import type { ParallelStepParams, PresetStep, StepResult } from "@app/automate/lib/types";
import { makeResult } from "./helpers";

async function parallelHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
    const start = performance.now();
    const params = step.params as unknown as ParallelStepParams;
    const onError = params.onError ?? "stop";

    if (!params.steps || params.steps.length === 0) {
        return makeResult("error", null, start, "Parallel step has no child step IDs");
    }

    // Look up child step definitions from the full preset
    // The engine injects __allSteps into the context
    const allSteps = ctx.evaluate("__allSteps") as PresetStep[] | undefined;
    if (!allSteps) {
        return makeResult("error", null, start, "Engine did not inject __allSteps into context");
    }

    const childSteps = params.steps.map((id) => {
        const found = allSteps.find((s) => s.id === id);
        if (!found) {
            throw new Error(`Parallel step "${step.id}" references unknown step ID: "${id}"`);
        }
        return found;
    });

    const executeChild = async (childStep: PresetStep): Promise<{ id: string; result: StepResult }> => {
        const handler = resolveStepHandler(childStep.action);
        if (!handler) {
            return {
                id: childStep.id,
                result: makeResult("error", null, start, `Unknown action: ${childStep.action}`),
            };
        }
        const result = await handler(childStep, ctx);
        return { id: childStep.id, result };
    };

    const output: Record<string, StepResult> = {};
    let failureCount = 0;

    if (onError === "stop") {
        try {
            const results = await Promise.all(childSteps.map(executeChild));
            for (const { id, result } of results) {
                output[id] = result;
                ctx.steps[id] = result;
                if (result.status === "error") {
                    failureCount++;
                }
            }
        } catch (error) {
            return makeResult("error", output, start, error instanceof Error ? error.message : String(error));
        }
    } else {
        const settled = await Promise.allSettled(childSteps.map(executeChild));
        for (const entry of settled) {
            if (entry.status === "fulfilled") {
                output[entry.value.id] = entry.value.result;
                ctx.steps[entry.value.id] = entry.value.result;
                if (entry.value.result.status === "error") {
                    failureCount++;
                }
            } else {
                failureCount++;
            }
        }
    }

    const status = failureCount === 0 ? "success" : "error";
    const error = failureCount > 0 ? `${failureCount}/${childSteps.length} parallel steps failed` : undefined;
    return makeResult(status, output, start, error);
}

registerStepHandler("parallel", parallelHandler);
registerStepCatalog({
    prefix: "parallel",
    description: "Run steps in parallel",
    actions: [
        {
            action: "parallel",
            description: "Execute multiple steps concurrently",
            params: [
                { name: "steps", required: true, description: "Array of step IDs to run in parallel" },
                { name: "onError", description: "'stop' or 'continue' (default: 'stop')" },
            ],
        },
    ],
});
