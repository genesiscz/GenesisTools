import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * WHAM hard-rejects `store: true` (400 "Store must be set to false", probed
 * live 2026-08-11), so the Responses API's server-side item persistence does
 * not exist on this upstream. Responses clients (Vercel AI SDK, sentry-mcp's
 * embedded agent) still chain tool-call turns by sending
 * `{ type: "item_reference", id: "fc_..." }` instead of echoing the full item —
 * a pointer into storage the upstream doesn't have, answered with
 * "Item with id ... not found. Items are not persisted when `store` is set to
 * false". The proxy plays the store instead: every output item that crosses it
 * (streaming or accumulated) is remembered here, and incoming references are
 * inlined back into full items, which WHAM accepts even unstored (verified
 * live: a replayed full function_call with its id returns 200).
 */

const MAX_ITEMS = 4096;

const itemsById = new Map<string, Record<string, unknown>>();

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rememberWhamOutputItem(item: unknown): void {
    if (!isObject(item) || typeof item.id !== "string" || item.id.length === 0) {
        return;
    }

    // Refresh insertion order so busy conversations aren't evicted mid-flight.
    itemsById.delete(item.id);
    itemsById.set(item.id, item);

    while (itemsById.size > MAX_ITEMS) {
        const oldest = itemsById.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        itemsById.delete(oldest);
    }
}

export interface ResolvedInput {
    input: unknown[];
    /** Reference ids we had no record of (proxy restarted mid-conversation). */
    unresolved: string[];
    /** call_ids of function_call_output items dropped because their function_call is gone. */
    orphanedOutputs: string[];
}

/**
 * Inline `item_reference` input items from the store. Unresolvable references
 * are dropped, and so are `function_call_output` items whose `call_id` no
 * longer has a matching `function_call` in the resolved input — sending an
 * orphaned output is its own upstream 400 ("No tool call found for function
 * call output with call_id ..."), and a model that re-issues the call recovers,
 * while a hard-failed turn does not.
 */
export function resolveWhamItemReferences(input: unknown[]): ResolvedInput {
    const unresolved: string[] = [];
    const resolved: unknown[] = [];

    for (const item of input) {
        if (!isObject(item) || item.type !== "item_reference" || typeof item.id !== "string") {
            resolved.push(item);
            continue;
        }

        const cached = itemsById.get(item.id);
        if (cached === undefined) {
            unresolved.push(item.id);
            continue;
        }

        resolved.push(cached);
    }

    if (unresolved.length === 0) {
        return { input: resolved, unresolved, orphanedOutputs: [] };
    }

    const knownCallIds = new Set<string>();

    for (const item of resolved) {
        if (isObject(item) && item.type === "function_call" && typeof item.call_id === "string") {
            knownCallIds.add(item.call_id);
        }
    }

    const orphanedOutputs: string[] = [];
    const withoutOrphans = resolved.filter((item) => {
        if (!isObject(item) || item.type !== "function_call_output" || typeof item.call_id !== "string") {
            return true;
        }

        if (knownCallIds.has(item.call_id)) {
            return true;
        }

        orphanedOutputs.push(item.call_id);
        return false;
    });

    return { input: withoutOrphans, unresolved, orphanedOutputs };
}

/**
 * Byte-transparent SSE passthrough that harvests `response.output_item.done`
 * items into the store as they stream to the client.
 */
export function createWhamItemHarvestTransform(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    let pending = "";

    function scan(text: string, flush: boolean): void {
        pending += text;
        const lines = pending.split("\n");
        pending = flush ? "" : (lines.pop() ?? "");

        for (const line of lines.concat(flush && pending.length > 0 ? [pending] : [])) {
            const trimmed = line.trimStart();

            if (!trimmed.startsWith("data:") || !trimmed.includes("response.output_item.done")) {
                continue;
            }

            let event: unknown;
            try {
                event = SafeJSON.parse(trimmed.slice("data:".length).trim(), { strict: true });
            } catch (err) {
                logger.debug({ err }, "ai-proxy: item-harvest SSE line parse failed");
                continue;
            }

            if (isObject(event) && event.type === "response.output_item.done" && isObject(event.item)) {
                rememberWhamOutputItem(event.item);
            }
        }
    }

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            controller.enqueue(chunk);
            scan(decoder.decode(chunk, { stream: true }), false);
        },
        flush() {
            scan(decoder.decode(), true);
        },
    });
}

export function whamItemStoreSize(): number {
    return itemsById.size;
}

export function resetWhamItemStore(): void {
    itemsById.clear();
}
