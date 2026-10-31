import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

/** Claude's reading of a transcript line into `tool call id → full input`. */
export function claudeToolInputLine(line: string, keys: Map<string, string>): void {
    if (!line.includes('"tool_use"')) {
        return;
    }

    const record = parseTranscriptLine(line);
    const message = record && isObject(record.message) ? record.message : null;
    const content = message && Array.isArray(message.content) ? message.content.filter(isObject) : [];

    for (const block of content) {
        if (block.type === "tool_use" && typeof block.id === "string") {
            keys.set(block.id, SafeJSON.stringify(block.input ?? null, { strict: true }) ?? "");
        }
    }
}
