import { decode, encode } from "gpt-3-encoder";

export function countTokens(text: string): number {
    try {
        return encode(text).length;
    } catch {
        // Fallback estimate
        return Math.ceil(text.split(/\s+/).length * 1.3);
    }
}

export function limitToTokens(
    text: string,
    maxTokens?: number
): { text: string; tokens: number; truncated: boolean } {
    const tokens = countTokens(text);

    if (!maxTokens || tokens <= maxTokens) {
        return { text, tokens, truncated: false };
    }

    try {
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
