import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import type { UsageEvent } from "./types";

interface RawUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    speed?: string;
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
    isSidechain?: boolean;
    message?: RawMessage;
}

function num(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRawLine(value: unknown): value is RawLine {
    return typeof value === "object" && value !== null;
}

/**
 * The service tier a Claude call was billed at. Claude Code writes `usage.speed` on every call, and only `fast`
 * changes the price (fast mode bills a multiple of the standard rates), so `standard` and a missing field are
 * the standard tier: undefined. Every reader of a Claude usage object asks this one function.
 */
export function claudeServiceTier(usage: { speed?: unknown }): "fast" | undefined {
    return usage.speed === "fast" ? "fast" : undefined;
}

export interface ClaudeCacheWrites {
    /** Every cache-write token of the call. */
    total: number;
    /** The one-hour share of `total` (billed at its own rate), never more than `total`. */
    oneHour: number;
}

function tokenCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A Claude call's cache writes. The nested `cache_creation` split, when the record has one, is the total
 * (five-minute plus one-hour writes); otherwise the top-level `cache_creation_input_tokens`. Every reader of a Claude
 * usage object asks this one function, so the spend reports, hub insights and session analysis price one call alike.
 */
export function claudeCacheWrites(usage: {
    cache_creation_input_tokens?: unknown;
    cache_creation?: unknown;
}): ClaudeCacheWrites {
    const nested = usage.cache_creation;

    if (!isObject(nested)) {
        return { total: tokenCount(usage.cache_creation_input_tokens), oneHour: 0 };
    }

    const oneHour = tokenCount(nested.ephemeral_1h_input_tokens);
    const total = tokenCount(nested.ephemeral_5m_input_tokens) + oneHour;
    return { total, oneHour: Math.min(oneHour, total) };
}

export function parseTranscriptLine(line: string): UsageEvent | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }

    let rawUnknown: unknown;
    try {
        rawUnknown = SafeJSON.parse(trimmed, { strict: true });
    } catch (err) {
        logger.debug({ err }, "ai-spend: skipping malformed transcript line");
        return null;
    }

    if (!isRawLine(rawUnknown)) {
        return null;
    }

    const raw = rawUnknown;
    if (raw.type !== "assistant") {
        return null;
    }

    const message = raw.message;
    if (!message?.usage || !message.id) {
        return null;
    }

    const serviceTier = claudeServiceTier(message.usage);
    const cacheWrites = claudeCacheWrites(message.usage);

    return {
        messageId: message.id,
        ...(raw.isSidechain === true ? { isSidechain: true } : {}),
        model: message.model ?? "unknown",
        timestamp: raw.timestamp ?? "",
        project: raw.cwd ?? "",
        sessionId: raw.sessionId ?? "",
        inputTokens: num(message.usage.input_tokens),
        outputTokens: num(message.usage.output_tokens),
        cacheCreationTokens: cacheWrites.total,
        ...(cacheWrites.oneHour > 0 ? { cacheCreation1hTokens: cacheWrites.oneHour } : {}),
        cacheReadTokens: num(message.usage.cache_read_input_tokens),
        ...(serviceTier ? { serviceTier } : {}),
    };
}
