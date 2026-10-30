import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * What the newest rows of a Claude Code transcript say about its prompt cache: the last real model turn's usage and
 * model, the turn before it (a model switch), when the main thread last wrote the cache, when a person last typed,
 * and the exact context after a compaction that no turn has followed yet. Read from the tail by
 * `parseClaudeTailUsage`; the session listing (`tools claude usage`, the cache banners) caches it per file.
 */
export interface ClaudeTailUsage {
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    inputTokens: number;
    /** The model id of the last real turn, as the transcript names it (`claude-opus-4-6`). */
    model: string | null;
    /** The model id of the real turn before it. */
    prevModel: string | null;
    /** Last main-thread user/assistant timestamp. */
    lastCacheAt: number | null;
    /** Timestamp of the last real typed user message (not tool results, not compact summaries). */
    lastUserAt: number | null;
    /** `compactMetadata.postTokens` when compaction happened after the last real turn. */
    compactedPostTokens: number | null;
}

export function emptyClaudeTailUsage(): ClaudeTailUsage {
    return {
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        inputTokens: 0,
        model: null,
        prevModel: null,
        lastCacheAt: null,
        lastUserAt: null,
        compactedPostTokens: null,
    };
}

function cacheAtFromLine(obj: { type?: unknown; timestamp?: unknown; isSidechain?: unknown }): number | null {
    if (obj.type !== "user" && obj.type !== "assistant") {
        return null;
    }

    if (obj.isSidechain === true) {
        return null;
    }

    if (typeof obj.timestamp !== "string") {
        return null;
    }

    const parsed = Date.parse(obj.timestamp);

    if (!Number.isFinite(parsed)) {
        return null;
    }

    return parsed;
}

/**
 * A real typed user message: main-thread, not a tool result, not the injected
 * compaction summary, not a meta record. Content is a string, or an array with a
 * text part (tool results are arrays of tool_result parts only).
 */
function userAtFromLine(obj: {
    type?: unknown;
    timestamp?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    isCompactSummary?: unknown;
    message?: { content?: unknown };
}): number | null {
    if (obj.type !== "user" || obj.isSidechain === true || obj.isMeta === true || obj.isCompactSummary === true) {
        return null;
    }

    const content = obj.message?.content;
    const isTyped =
        typeof content === "string" ||
        (Array.isArray(content) && content.some((part) => (part as { type?: unknown })?.type === "text"));

    if (!isTyped || typeof obj.timestamp !== "string") {
        return null;
    }

    const parsed = Date.parse(obj.timestamp);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the tail rows of a Claude transcript from the newest back, until every field is found or the rows run out.
 * A row that does not parse (the one being written) is skipped and logged at debug.
 */
export function parseClaudeTailUsage(lines: string[], filePath: string): ClaudeTailUsage {
    const usage = emptyClaudeTailUsage();
    let foundUsage = false;
    let foundPrev = false;

    for (let i = lines.length - 1; i >= 0; i--) {
        // Everything is found — the rest of the tail can only be older.
        if (foundPrev && usage.lastUserAt !== null && usage.lastCacheAt !== null) {
            break;
        }

        try {
            const obj = SafeJSON.parse(lines[i], { strict: true });

            if (usage.lastCacheAt === null) {
                usage.lastCacheAt = cacheAtFromLine(obj);
            }

            if (usage.lastUserAt === null) {
                usage.lastUserAt = userAtFromLine(obj);
            }

            // A compaction after the last real turn states the exact post-compact
            // context in compactMetadata.postTokens — no assistant usage carries it yet.
            if (!foundUsage && usage.compactedPostTokens === null && obj.type === "system") {
                if (obj.subtype === "compact_boundary") {
                    const post = obj.compactMetadata?.postTokens;
                    usage.compactedPostTokens = typeof post === "number" ? post : 0;
                }

                continue;
            }

            if (obj.type !== "assistant" || !obj.message?.usage) {
                continue;
            }

            // Claude Code writes local notices (API errors, "No response.") as assistant
            // records with model "<synthetic>". They are not model turns: no real usage,
            // and surfacing the model string as-is is the "<synthetic>" bug.
            if (obj.message.model === "<synthetic>") {
                continue;
            }

            const model = typeof obj.message.model === "string" && obj.message.model ? obj.message.model : null;

            if (!foundUsage) {
                const u = obj.message.usage;
                usage.totalTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
                usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
                usage.cacheCreateTokens = u.cache_creation_input_tokens ?? 0;
                usage.inputTokens = u.input_tokens ?? 0;
                usage.model = model;
                foundUsage = true;
                continue;
            }

            if (!foundPrev) {
                usage.prevModel = model;
                foundPrev = true;
            }
        } catch (err) {
            logger.debug({ err, filePath }, "skip malformed session tail line");
        }
    }

    return usage;
}
