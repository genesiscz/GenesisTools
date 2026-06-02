import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { UsageEvent } from "./types";

interface RawUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

interface RawMessage {
    id?: string;
    model?: string;
    usage?: RawUsage;
}

interface RawLine {
    type?: string;
    timestamp?: string;
    cwd?: string;
    sessionId?: string;
    message?: RawMessage;
}

function num(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseTranscriptLine(line: string): UsageEvent | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }

    let raw: RawLine;
    try {
        raw = SafeJSON.parse(trimmed) as RawLine;
    } catch (err) {
        logger.debug({ err }, "ai-spend: skipping malformed transcript line");
        return null;
    }

    if (raw.type !== "assistant") {
        return null;
    }

    const message = raw.message;
    if (!message?.usage || !message.id) {
        return null;
    }

    return {
        messageId: message.id,
        model: message.model ?? "unknown",
        timestamp: raw.timestamp ?? "",
        project: raw.cwd ?? "",
        sessionId: raw.sessionId ?? "",
        inputTokens: num(message.usage.input_tokens),
        outputTokens: num(message.usage.output_tokens),
        cacheCreationTokens: num(message.usage.cache_creation_input_tokens),
        cacheReadTokens: num(message.usage.cache_read_input_tokens),
    };
}
