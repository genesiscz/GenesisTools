import { SafeJSON } from "@genesiscz/utils/json";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Skip truncated or malformed JSONL instead of aborting the whole convert. */
export function parseTranscriptLine(line: string | unknown): Record<string, unknown> | null {
    if (typeof line !== "string") {
        return isRecord(line) ? line : null;
    }
    if (!line.trim()) {
        return null;
    }
    try {
        const parsed = SafeJSON.parse(line, { strict: true });
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}
