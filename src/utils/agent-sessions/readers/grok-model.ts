/** Grok's `currentModel`: its chat rows name no model, so `summary.json` beside them answers (`current_model_id`). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

/** `current_model_id` of a Grok `summary.json` text, or undefined when it names none. */
export function grokModelOfSummary(text: string): string | undefined {
    const value: unknown = SafeJSON.parse(text, { strict: true });

    if (typeof value !== "object" || value === null || !("current_model_id" in value)) {
        return undefined;
    }

    return typeof value.current_model_id === "string" && value.current_model_id ? value.current_model_id : undefined;
}

/** The model a Grok session runs now, from the `summary.json` in its session folder. */
export function grokCurrentModel(transcriptPath: string): string | null {
    const path = join(dirname(transcriptPath), "summary.json");

    try {
        return grokModelOfSummary(readFileSync(path, "utf8")) ?? null;
    } catch {
        // No summary yet, or one being rewritten: the session names no model. Not logged, as in `session-model.ts`.
        return null;
    }
}
