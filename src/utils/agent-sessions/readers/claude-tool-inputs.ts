import { isRecord } from "@genesiscz/utils/ai/transcripts/native-scan";
import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";
import { SafeJSON } from "@genesiscz/utils/json";

/** Claude's reading of a transcript line into `tool call id → full input`. */
export function claudeToolInputLine(line: string, keys: Map<string, string>): void {
    if (!line.includes('"tool_use"')) {
        return;
    }

    const record = parseTranscriptLine(line);
    const message = record && isRecord(record.message) ? record.message : null;
    const content = message && Array.isArray(message.content) ? message.content.filter(isRecord) : [];

    for (const block of content) {
        if (block.type === "tool_use" && typeof block.id === "string") {
            keys.set(block.id, SafeJSON.stringify(block.input ?? null, { strict: true }) ?? "");
        }
    }
}
