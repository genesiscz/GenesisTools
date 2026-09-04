import { createHash } from "node:crypto";
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
 *
 * xAI's Responses API (grok subscription and API key) has the same gap from
 * the other side: it knows no `item_reference` at all (422 "unknown item type
 * item_reference", verified live 2026-09-03) and takes the full items back,
 * reasoning included, so the grok providers share this store.
 *
 * Every entry is SCOPED to the client that produced it. The proxy fronts
 * several separately billed clients, and a lookup by id alone let client B
 * inline client A's function_call — tool name and full arguments — into its own
 * upstream request, and read it back in its own turn, just by sending an id it
 * had seen or guessed.
 */

const MAX_ITEMS = 4096;

/** Keyed `<scope>\u0000<item id>`; one LRU budget across all clients. */
const itemsByScopedId = new Map<string, Record<string, unknown>>();

/** No Authorization header at all: a direct/unauthenticated caller, its own partition. */
const ANONYMOUS_SCOPE = "anonymous";

/**
 * The store partition for one proxy client, taken from the presented bearer.
 * Hashed, so no key material sits in a process-global map key. Every client has
 * its own key (`resolveClient`), so this separates exactly the identities the
 * ledger bills separately.
 */
export function whamItemScope(req: Request): string {
    const presented = req.headers.get("authorization") ?? req.headers.get("x-api-key");

    if (!presented) {
        return ANONYMOUS_SCOPE;
    }

    return createHash("sha256").update(presented).digest("hex").slice(0, 32);
}

function scopedKey(scope: string, id: string): string {
    return `${scope}\u0000${id}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rememberWhamOutputItem(scope: string, item: unknown): void {
    if (!isObject(item) || typeof item.id !== "string" || item.id.length === 0) {
        return;
    }

    const key = scopedKey(scope, item.id);
    // Refresh insertion order so busy conversations aren't evicted mid-flight.
    itemsByScopedId.delete(key);
    itemsByScopedId.set(key, item);

    while (itemsByScopedId.size > MAX_ITEMS) {
        const oldest = itemsByScopedId.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        itemsByScopedId.delete(oldest);
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
export function resolveWhamItemReferences(scope: string, input: unknown[]): ResolvedInput {
    const unresolved: string[] = [];
    const resolved: unknown[] = [];

    for (const item of input) {
        if (!isObject(item) || item.type !== "item_reference" || typeof item.id !== "string") {
            resolved.push(item);
            continue;
        }

        const cached = itemsByScopedId.get(scopedKey(scope, item.id));
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
export function createWhamItemHarvestTransform(scope: string): TransformStream<Uint8Array, Uint8Array> {
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
                rememberWhamOutputItem(scope, event.item);
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

/**
 * Inline `item_reference` pointers in a Responses body's `input`. Unresolved
 * references (and their orphaned outputs) are dropped and logged, as in the
 * WHAM path.
 */
export function inlineResponsesItemReferences<T extends Record<string, unknown>>(scope: string, body: T): T {
    if (!Array.isArray(body.input)) {
        return body;
    }

    const resolved = resolveWhamItemReferences(scope, body.input);

    if (resolved.unresolved.length > 0) {
        logger.warn(
            { unresolved: resolved.unresolved, orphanedOutputs: resolved.orphanedOutputs },
            "ai-proxy: dropped item_reference input items with no stored record (proxy restarted mid-conversation?)"
        );
    }

    return { ...body, input: resolved.input };
}

export function inlineResponsesItemReferencesInBodyText(scope: string, bodyText: string): string {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed) || !Array.isArray(parsed.input)) {
            return bodyText;
        }

        return SafeJSON.stringify(inlineResponsesItemReferences(scope, parsed));
    } catch (err) {
        logger.debug({ err }, "ai-proxy: item_reference inline skipped — body is not JSON");
        return bodyText;
    }
}

/**
 * The body of an upstream /responses reply with its output items remembered:
 * an SSE stream is harvested as it passes through, a JSON envelope is read
 * once and returned verbatim.
 */
export async function harvestResponsesOutput(scope: string, upstream: Response): Promise<BodyInit | null> {
    if (!upstream.ok || upstream.body === null) {
        return upstream.body;
    }

    const contentType = upstream.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
        return upstream.body.pipeThrough(createWhamItemHarvestTransform(scope));
    }

    const text = await upstream.text();

    try {
        const envelope = SafeJSON.parse(text, { strict: true });

        if (isObject(envelope) && Array.isArray(envelope.output)) {
            for (const item of envelope.output) {
                rememberWhamOutputItem(scope, item);
            }
        }
    } catch (err) {
        logger.debug({ err }, "ai-proxy: /responses envelope parse failed — no output items harvested");
    }

    return text;
}

export function whamItemStoreSize(): number {
    return itemsByScopedId.size;
}

export function resetWhamItemStore(): void {
    itemsByScopedId.clear();
}
