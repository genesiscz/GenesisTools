import { isObject } from "@genesiscz/utils/object";

/**
 * First Anthropic server tool offered by the request, or undefined.
 *
 * Server tools (`web_search_20250305`, `code_execution_*`, …) are executed
 * inside Anthropic's API during sampling and carry no `description` or
 * `input_schema`. Grok's Anthropic-compat endpoint only models custom tools,
 * so a body offering one dies in its deserializer with the opaque
 * `tools[0]: missing field description` — which reads like a proxy bug.
 * Custom tools have no `type` field (or `type: "custom"`).
 */
export function findServerTool(body: Record<string, unknown>): string | undefined {
    return findServerTools(body)[0];
}

/** Every server tool offered by the request — a mixed request must be judged whole. */
export function findServerTools(body: Record<string, unknown>): string[] {
    if (!Array.isArray(body.tools)) {
        return [];
    }

    const types: string[] = [];

    for (const tool of body.tools) {
        if (isObject(tool) && typeof tool.type === "string" && tool.type !== "custom") {
            types.push(tool.type);
        }
    }

    return types;
}
