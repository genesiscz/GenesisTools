// src/automate/lib/steps/loop.ts

import { registerStepHandler, registerStepCatalog, resolveStepHandler } from "../registry";
import type { StepContext } from "../registry";
import type { ForEachStepParams, PresetStep, StepResult, WhileStepParams } from "../types";
import { makeResult } from "./helpers";

// --- forEach ---

async function forEachHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as ForEachStepParams;

  const items = ctx.evaluate(params.items) as unknown[];
  if (!Array.isArray(items)) {
    return makeResult("error", null, start, `forEach items did not resolve to an array: ${params.items}`);
  }

  const itemVar = params.as ?? "item";
  const indexVar = params.indexAs ?? "index";
  const concurrency = params.concurrency ?? 1;
  const childStep = params.step;
  const handler = resolveStepHandler(childStep.action);

  if (!handler) {
    return makeResult("error", null, start, `Unknown action in forEach body: ${childStep.action}`);
  }

  const results: StepResult[] = [];

  const processItem = async (item: unknown, index: number): Promise<StepResult> => {
    // Create a child context with item/index injected
    const childCtx: StepContext = {
      ...ctx,
      evaluate: (expr: string) => {
        if (expr === itemVar) return item;
        if (expr === indexVar) return index;
        if (expr.startsWith(`${itemVar}.`)) {
          const path = expr.substring(itemVar.length + 1);
          return path.split(".").reduce<unknown>((obj, key) => {
            return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
          }, item);
        }
        return ctx.evaluate(expr);
      },
      interpolate: (template: string) => {
        // Replace {{ item }}, {{ item.prop }}, {{ index }} first, then delegate
        let result = template.replace(new RegExp(`\\{\\{\\s*${itemVar}(?:\\.[\\w.]+)?\\s*\\}\\}`, "g"), (match) => {
          const expr = match.replace(/\{\{\s*|\s*\}\}/g, "");
          const val = childCtx.evaluate(expr);
          return typeof val === "string" ? val : JSON.stringify(val);
        });
        result = result.replace(new RegExp(`\\{\\{\\s*${indexVar}\\s*\\}\\}`, "g"), String(index));
        return ctx.interpolate(result);
      },
    };

    const iterationStep: PresetStep = {
      ...childStep,
      id: `${step.id}[${index}]`,
    };

    return handler(iterationStep, childCtx);
  };

  if (concurrency <= 1) {
    // Sequential
    for (let i = 0; i < items.length; i++) {
      const result = await processItem(items[i], i);
      results.push(result);
      ctx.steps[`${step.id}[${i}]`] = result;
    }
  } else {
    // Parallel with bounded concurrency
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map((item, batchIdx) => processItem(item, i + batchIdx)),
      );
      for (const [batchIdx, entry] of batchResults.entries()) {
        const globalIdx = i + batchIdx;
        if (entry.status === "fulfilled") {
          results.push(entry.value);
          ctx.steps[`${step.id}[${globalIdx}]`] = entry.value;
        } else {
          const failResult = makeResult(
            "error",
            null,
            start,
            entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
          );
          results.push(failResult);
          ctx.steps[`${step.id}[${globalIdx}]`] = failResult;
        }
      }
    }
  }

  const failureCount = results.filter((r) => r.status === "error").length;
  const outputs = results.map((r) => r.output);

  return makeResult(
    failureCount === 0 ? "success" : "error",
    { results: outputs, count: items.length, failures: failureCount },
    start,
    failureCount > 0 ? `${failureCount}/${items.length} iterations failed` : undefined,
  );
}

// --- while ---

async function whileHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as WhileStepParams;
  const maxIterations = params.maxIterations ?? 100;
  const childStep = params.step;
  const handler = resolveStepHandler(childStep.action);

  if (!handler) {
    return makeResult("error", null, start, `Unknown action in while body: ${childStep.action}`);
  }

  const results: StepResult[] = [];
  let iteration = 0;

  while (iteration < maxIterations) {
    const conditionResult = ctx.evaluate(params.condition);
    if (!conditionResult) break;

    const iterationStep: PresetStep = {
      ...childStep,
      id: `${step.id}[${iteration}]`,
    };

    const result = await handler(iterationStep, ctx);
    results.push(result);
    ctx.steps[`${step.id}[${iteration}]`] = result;

    if (result.status === "error" && step.onError !== "continue") break;

    iteration++;
  }

  const failureCount = results.filter((r) => r.status === "error").length;

  return makeResult(
    failureCount === 0 ? "success" : "error",
    { results: results.map((r) => r.output), iterations: iteration, failures: failureCount },
    start,
    iteration >= maxIterations
      ? `Hit max iterations (${maxIterations})`
      : failureCount > 0
        ? `${failureCount} iterations failed`
        : undefined,
  );
}

registerStepHandler("forEach", forEachHandler);
registerStepHandler("while", whileHandler);

registerStepCatalog({
  prefix: "forEach",
  description: "Iterate over array items",
  actions: [
    { action: "forEach", description: "Execute a step for each item in an array", params: [
      { name: "items", required: true, description: "Expression resolving to an array" },
      { name: "step", required: true, description: "Step definition to run per item" },
      { name: "concurrency", description: "Parallel concurrency (default: 1 = sequential)" },
      { name: "as", description: "Variable name for current item (default: 'item')" },
      { name: "indexAs", description: "Variable name for index (default: 'index')" },
    ]},
  ],
});

registerStepCatalog({
  prefix: "while",
  description: "Loop while condition is true",
  actions: [
    { action: "while", description: "Repeat a step while condition holds", params: [
      { name: "condition", required: true, description: "Expression evaluated each iteration" },
      { name: "step", required: true, description: "Step definition to run" },
      { name: "maxIterations", description: "Safety limit (default: 100)" },
    ]},
  ],
});
