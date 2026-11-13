import type { Endpoint, EndpointInput, EndpointOutput } from "@app/dev-dashboard/contract/endpoint-table";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteContext, RouteDef, RouteHandler, RouteResult } from "@app/dev-dashboard/server/types";
import type { z } from "zod";

/** The header a caller sets to make a write safe to retry. */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/**
 * How a row is served. `input` is the zod check of the request (path params, then the query for GET, else the JSON
 * body); zod stays here, in the server binding, and never enters the contract. `run` answers with the row's output.
 */
export interface Binding<E extends Endpoint> {
    input: z.ZodType<EndpointInput<E>>;
    /** The body of the 400 a refused input gets (`{ error: invalid }`); the routes kept their old messages. */
    invalid: string;
    run: (input: EndpointInput<E>, ctx: RouteContext) => Promise<EndpointOutput<E> | RouteResult>;
    /** Maps a thrown error to a response; a 500 with its message when omitted. */
    error?: (err: unknown) => RouteResult;
    /** `raw`: the body is not JSON (an upload); the input holds only the path params and the query. */
    body?: "json" | "raw";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
    return isRecord(value) && typeof value.kind === "string" && typeof value.status === "number";
}

async function rawInput(method: string, ctx: RouteContext, kind: "json" | "raw"): Promise<unknown> {
    if (method === "GET" || kind === "raw") {
        return { ...Object.fromEntries(ctx.query.entries()), ...ctx.params };
    }

    const body = await ctx.readJson<unknown>().catch(() => undefined);
    return isRecord(body) ? { ...body, ...ctx.params } : body === undefined ? { ...ctx.params } : body;
}

interface StoredReceipt {
    at: number;
    result: Promise<RouteResult>;
}

/** A retried write within this window gets the first answer. Past it the key is forgotten. */
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX = 500;

/**
 * The first answer of every keyed write, by method, path and `Idempotency-Key`. In memory: the server is one
 * long-lived process, and a retry comes within seconds (a phone that lost the answer, a proxy replay). A second
 * request while the first still runs waits for the same answer, so the write runs once.
 */
export class ReceiptCache {
    private readonly receipts = new Map<string, StoredReceipt>();

    constructor(private readonly now: () => number = Date.now) {}

    once(key: string, run: () => Promise<RouteResult>): Promise<RouteResult> {
        const at = this.now();

        for (const [stored, receipt] of this.receipts) {
            if (at - receipt.at > IDEMPOTENCY_TTL_MS || this.receipts.size > IDEMPOTENCY_MAX) {
                this.receipts.delete(stored);
            }
        }

        const earlier = this.receipts.get(key);

        if (earlier) {
            return earlier.result;
        }

        const result = run();
        this.receipts.set(key, { at, result });
        // A write that threw can be tried again, and so can a 4xx: a refused request (no token, a bad body) wrote
        // nothing, and keeping it would answer the corrected retry with the refusal.
        result.then(
            (answer) => {
                if ("status" in answer && answer.status >= 400 && answer.status < 500) {
                    this.receipts.delete(key);
                }
            },
            () => this.receipts.delete(key)
        );
        return result;
    }
}

const sharedReceipts = new ReceiptCache();

/** Every route made from a table row, so the table test can tell a bound route from a hand-written pattern. */
const ROW_BOUND = new WeakSet<RouteDef>();

/** Whether this route was made from its table row (`bindEndpoint` or `bindHandler`). */
export function isBoundFromRow(def: RouteDef): boolean {
    return ROW_BOUND.has(def);
}

/** The method, the pattern and `longLived` of a row: what a route takes from it, never restated. */
function rowRoute(endpoint: Endpoint, handler: RouteHandler): RouteDef {
    const def: RouteDef = {
        method: endpoint.method,
        pattern: endpoint.path,
        ...(endpoint.timeout === "stream" ? { longLived: true } : {}),
        handler,
    };

    ROW_BOUND.add(def);
    return def;
}

/** One route from one table row. The method, the pattern and `longLived` come from the row, never restated. */
export function bindEndpoint<E extends Endpoint>(
    endpoint: E,
    binding: Binding<E>,
    receipts: ReceiptCache = sharedReceipts
): RouteDef {
    /** The answer, or a rejection when the binding threw: the receipt cache must see a throw to drop the key. */
    const run = async (ctx: RouteContext): Promise<RouteResult> => {
        const parsed = binding.input.safeParse(await rawInput(endpoint.method, ctx, binding.body ?? "json"));

        if (!parsed.success) {
            return { kind: "json", status: 400, body: { error: binding.invalid } };
        }

        const output = await binding.run(parsed.data, ctx);
        return isRouteResult(output) ? output : { kind: "json", status: 200, body: output };
    };
    const failure = (err: unknown): RouteResult => (binding.error ? binding.error(err) : errorResult(err));

    return rowRoute(endpoint, (ctx) => {
        const key = ctx.headers[IDEMPOTENCY_HEADER];

        // Only a keyed-write row is cached here. `act` dedupes per token and key inside `act()`; a cache keyed
        // without the act token would hand one token's receipt to another token that reused the key.
        if (endpoint.policy !== "keyed-write" || !key) {
            return run(ctx).catch(failure);
        }

        // The throw is turned into its error answer only after the cache, so a transient failure is retried
        // instead of pinning the key to a 500 for the cache's lifetime.
        return receipts.once(`${endpoint.method} ${ctx.pathname} ${key}`, () => run(ctx)).catch(failure);
    });
}

/**
 * A route whose handler is still written by hand (it reads the request itself), bound from its table row: the method,
 * the pattern and `longLived` come from the row. A `keyed-write` row answers a retry that carries the same
 * `Idempotency-Key` with its first answer, like `bindEndpoint`; without a key the handler runs as it always did.
 */
export function bindHandler(
    endpoint: Endpoint,
    handler: RouteHandler,
    receipts: ReceiptCache = sharedReceipts
): RouteDef {
    if (endpoint.policy !== "keyed-write") {
        return rowRoute(endpoint, handler);
    }

    return rowRoute(endpoint, async (ctx) => {
        const key = ctx.headers[IDEMPOTENCY_HEADER];
        return key
            ? receipts.once(`${endpoint.method} ${ctx.pathname} ${key}`, async () => handler(ctx))
            : handler(ctx);
    });
}
