// src/automate/lib/steps/transform.ts

import { registerStepHandler, registerStepCatalog } from "../registry";
import type { StepContext } from "../registry";
import type { ArrayStepParams, JsonStepParams, PresetStep, StepResult, TextStepParams } from "../types";
import { makeResult } from "./helpers";

// jsonpath has no TypeScript declarations
const jsonpath = require("jsonpath") as { query: (obj: unknown, path: string) => unknown[] };

// --- JSON Handler ---

async function jsonHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as JsonStepParams;
  const subAction = step.action.split(".")[1];

  try {
    switch (subAction) {
      case "parse": {
        const input = ctx.interpolate(params.input!);
        const parsed = JSON.parse(input);
        return makeResult("success", parsed, start);
      }

      case "stringify": {
        const input = ctx.evaluate(params.input!);
        const indent = params.indent ?? 2;
        const result = JSON.stringify(input, null, indent);
        return makeResult("success", result, start);
      }

      case "query": {
        const input = ctx.evaluate(params.input!);
        const query = ctx.interpolate(params.query!);
        const result = jsonpath.query(input, query);
        return makeResult("success", result, start);
      }

      default:
        return makeResult("error", null, start, `Unknown json action: ${subAction}`);
    }
  } catch (error) {
    return makeResult("error", null, start, error instanceof Error ? error.message : String(error));
  }
}

// --- Text Handler ---

async function textHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as TextStepParams;
  const subAction = step.action.split(".")[1];

  try {
    switch (subAction) {
      case "regex": {
        const input = String(ctx.evaluate(params.input!) ?? "");
        const pattern = ctx.interpolate(params.pattern!);
        const flags = params.flags ?? "g";
        const regex = new RegExp(pattern, flags);

        if (params.replacement !== undefined) {
          const result = input.replace(regex, ctx.interpolate(params.replacement));
          return makeResult("success", { result, matchCount: (input.match(regex) ?? []).length }, start);
        }

        const globalFlags = flags.includes("g") ? flags : `${flags}g`;
        const matches = Array.from(input.matchAll(new RegExp(pattern, globalFlags))).map((m) => ({
          match: m[0],
          groups: m.groups ?? {},
          index: m.index,
        }));
        return makeResult("success", { matches, count: matches.length }, start);
      }

      case "template": {
        const template = ctx.interpolate(params.template!);
        return makeResult("success", template, start);
      }

      case "split": {
        const input = String(ctx.evaluate(params.input!) ?? "");
        const separator = ctx.interpolate(params.separator ?? "\n");
        return makeResult("success", input.split(separator), start);
      }

      case "join": {
        const input = ctx.evaluate(params.input!) as string[];
        const separator = ctx.interpolate(params.separator ?? "\n");
        return makeResult("success", input.join(separator), start);
      }

      default:
        return makeResult("error", null, start, `Unknown text action: ${subAction}`);
    }
  } catch (error) {
    return makeResult("error", null, start, error instanceof Error ? error.message : String(error));
  }
}

// --- Array Handler ---

async function arrayHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as ArrayStepParams;
  const subAction = step.action.split(".")[1];

  try {
    const input = ctx.evaluate(params.input!) as unknown[];
    if (!Array.isArray(input)) {
      return makeResult("error", null, start, "Input is not an array");
    }

    switch (subAction) {
      case "filter": {
        const expression = params.expression!;
        const fn = new Function("item", "index", "vars", "steps", "env", `return (${expression});`);
        const result = input.filter((item, index) =>
          Boolean(fn(item, index, ctx.variables, ctx.steps, ctx.env)),
        );
        return makeResult("success", result, start);
      }

      case "map": {
        const expression = params.expression!;
        const fn = new Function("item", "index", "vars", "steps", "env", `return (${expression});`);
        const result = input.map((item, index) =>
          fn(item, index, ctx.variables, ctx.steps, ctx.env),
        );
        return makeResult("success", result, start);
      }

      case "sort": {
        const key = params.key;
        const order = params.order ?? "asc";
        const sorted = [...input].sort((a, b) => {
          const va = (key ? (a as Record<string, unknown>)[key] : a) as string | number;
          const vb = (key ? (b as Record<string, unknown>)[key] : b) as string | number;
          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
          return order === "asc" ? cmp : -cmp;
        });
        return makeResult("success", sorted, start);
      }

      case "flatten": {
        const result = input.flat(Infinity);
        return makeResult("success", result, start);
      }

      default:
        return makeResult("error", null, start, `Unknown array action: ${subAction}`);
    }
  } catch (error) {
    return makeResult("error", null, start, error instanceof Error ? error.message : String(error));
  }
}

// --- Register all ---

registerStepHandler("json", jsonHandler);
registerStepHandler("text", textHandler);
registerStepHandler("array", arrayHandler);

registerStepCatalog({
  prefix: "json",
  description: "JSON operations",
  actions: [
    { action: "json.parse", description: "Parse JSON string", params: [
      { name: "input", required: true, description: "JSON string to parse" },
    ]},
    { action: "json.stringify", description: "Stringify to JSON", params: [
      { name: "input", required: true, description: "Expression to stringify" },
      { name: "indent", description: "Indentation (default: 2)" },
    ]},
    { action: "json.query", description: "JSONPath query", params: [
      { name: "input", required: true, description: "Object expression to query" },
      { name: "query", required: true, description: "JSONPath expression (e.g. $.items[*].name)" },
    ]},
  ],
});

registerStepCatalog({
  prefix: "text",
  description: "Text operations",
  actions: [
    { action: "text.regex", description: "Regex match or replace", params: [
      { name: "input", required: true, description: "Input string" },
      { name: "pattern", required: true, description: "Regex pattern" },
      { name: "replacement", description: "Replacement string (omit for match-only)" },
      { name: "flags", description: "Regex flags (default: 'g')" },
    ]},
    { action: "text.template", description: "Interpolate a template string", params: [
      { name: "template", required: true, description: "Template with {{ expressions }}" },
    ]},
    { action: "text.split", description: "Split string into array", params: [
      { name: "input", required: true, description: "Input string" },
      { name: "separator", description: "Separator (default: newline)" },
    ]},
    { action: "text.join", description: "Join array into string", params: [
      { name: "input", required: true, description: "Array expression" },
      { name: "separator", description: "Separator (default: newline)" },
    ]},
  ],
});

registerStepCatalog({
  prefix: "array",
  description: "Array operations",
  actions: [
    { action: "array.filter", description: "Filter items by expression", params: [
      { name: "input", required: true, description: "Array expression" },
      { name: "expression", required: true, description: "JS expression (item, index available)" },
    ]},
    { action: "array.map", description: "Transform each item", params: [
      { name: "input", required: true, description: "Array expression" },
      { name: "expression", required: true, description: "JS expression (item, index available)" },
    ]},
    { action: "array.sort", description: "Sort array", params: [
      { name: "input", required: true, description: "Array expression" },
      { name: "key", description: "Object key to sort by" },
      { name: "order", description: "'asc' or 'desc' (default: 'asc')" },
    ]},
    { action: "array.flatten", description: "Flatten nested arrays", params: [
      { name: "input", required: true, description: "Array expression" },
    ]},
  ],
});
