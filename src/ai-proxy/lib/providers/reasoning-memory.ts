import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

/**
 * Claude Code 2.1.310 and later send no earlier-turn thinking on the first request of a typed turn, and every
 * thinking block again on the tool-loop requests after it. The Codex route turns thinking into reasoning items, so
 * that first request changed the upstream history at the first reasoning item and read 0% of the prompt cache, and
 * the next request missed again (session 8cf9eff2: 1.41M uncached tokens in 4 requests).
 *
 * This remembers, per client and conversation, the input items an assistant message produced while it carried its
 * thinking, keyed by the message's other blocks (tool call ids, text). A later copy of the same message without
 * thinking gets the same items back, so the upstream history stays byte-identical. In memory only: a proxy restart
 * forgets it, and the first turn after a restart misses once.
 */

const MAX_MESSAGES = 4096;

// Null marks an ambiguous identity: two different reasoning histories have the same visible blocks.
const itemsByMessage = new Map<string, Array<Record<string, unknown>> | null>();

/** The blocks that identify an assistant message once its thinking is gone; undefined when nothing identifies it. */
function messageKey(conversation: string, content: unknown[]): string | undefined {
    const identity = content.flatMap((block): Array<Record<string, unknown>> => {
        if (!isObject(block) || block.type === "thinking" || block.type === "redacted_thinking") {
            return [];
        }

        return [block];
    });

    if (identity.length === 0) {
        return undefined;
    }

    const hash = createHash("sha256").update(SafeJSON.stringify(identity)).digest("hex").slice(0, 32);
    return `${conversation}\u0000${hash}`;
}

export function hasThinking(content: unknown[]): boolean {
    return content.some((block) => isObject(block) && block.type === "thinking");
}

/** Remember the items a message produced with its thinking; only when at least one is a reasoning item. */
export function rememberMessageItems(
    conversation: string,
    content: unknown[],
    items: Array<Record<string, unknown>>
): void {
    const key = messageKey(conversation, content);

    if (key === undefined || !items.some((item) => item.type === "reasoning")) {
        return;
    }

    const previous = itemsByMessage.get(key);
    const ambiguous =
        previous === null || (previous !== undefined && SafeJSON.stringify(previous) !== SafeJSON.stringify(items));
    itemsByMessage.delete(key);
    itemsByMessage.set(key, ambiguous ? null : structuredClone(items));

    while (itemsByMessage.size > MAX_MESSAGES) {
        const oldest = itemsByMessage.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        itemsByMessage.delete(oldest);
    }
}

/** The items the same message produced when it still carried its thinking, or undefined. */
export function rememberedMessageItems(
    conversation: string,
    content: unknown[]
): Array<Record<string, unknown>> | undefined {
    const key = messageKey(conversation, content);
    const items = key === undefined ? undefined : itemsByMessage.get(key);
    return items ? structuredClone(items) : undefined;
}

export function resetReasoningMemoryForTests(): void {
    itemsByMessage.clear();
}
