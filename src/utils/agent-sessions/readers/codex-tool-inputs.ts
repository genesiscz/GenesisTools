import { isRecord } from "@genesiscz/utils/ai/transcripts/native-scan";
import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";
import { SafeJSON } from "@genesiscz/utils/json";

/** Codex's reading of a rollout line into `tool call id → full input`. */
export function codexToolInputLine(line: string, keys: Map<string, string>): void {
    if (!line.includes('"call_id"')) {
        return;
    }

    const record = parseTranscriptLine(line);
    const payload = record && isRecord(record.payload) ? record.payload : null;

    if (
        payload &&
        (payload.type === "function_call" || payload.type === "custom_tool_call") &&
        typeof payload.call_id === "string"
    ) {
        const input = payload.arguments ?? payload.input ?? null;
        keys.set(
            payload.call_id,
            typeof input === "string" ? input : (SafeJSON.stringify(input, { strict: true }) ?? "")
        );
    }
}
