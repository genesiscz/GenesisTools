/**
 * Shared token counting utilities for CLI tools.
 * Two modes: fast heuristic (no deps) and accurate encoder-based.
 */

/**
 * Fast heuristic token estimation (~4 chars/token). No dependencies.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Accurate token count using GPT-3 encoder.
 * Falls back to word-count heuristic on error.
 *
 * Requires `gpt-3-encoder` package.
 */
export function countTokens(text: string): number {
    try {
        const { encode } = require("gpt-3-encoder");
        return encode(text).length;
    } catch {
        const trimmed = text.trim();
        if (!trimmed) {
            return 0;
        }
        return Math.ceil(trimmed.split(/\s+/).length * 1.3);
    }
}

/**
 * Truncate text to a token limit. Returns metadata about the result.
 *
 * Requires `gpt-3-encoder` package for accurate truncation.
 */
export function limitToTokens(text: string, maxTokens?: number): { text: string; tokens: number; truncated: boolean } {
    const tokens = countTokens(text);

    if (maxTokens == null) {
        return { text, tokens, truncated: false };
    }

    if (!Number.isInteger(maxTokens) || maxTokens < 0) {
        throw new Error(`maxTokens must be a non-negative integer, got: ${maxTokens}`);
    }

    if (tokens <= maxTokens) {
        return { text, tokens, truncated: false };
    }

    if (maxTokens === 0) {
        return { text: "", tokens: 0, truncated: text.length > 0 };
    }

    try {
        const { encode, decode } = require("gpt-3-encoder");
        const encoded = encode(text);
        const truncated = encoded.slice(0, maxTokens);
        return {
            text: decode(truncated),
            tokens: maxTokens,
            truncated: true,
        };
    } catch {
        // Fallback: character-based truncation
        const ratio = maxTokens / tokens;
        const chars = Math.floor(text.length * ratio);
        return {
            text: text.slice(0, chars),
            tokens: maxTokens,
            truncated: true,
        };
    }
}
