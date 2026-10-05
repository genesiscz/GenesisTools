import { createHash, timingSafeEqual } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Update } from "grammy/types";

export const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** A `message` update is a few kilobytes. Anything near this size is not Telegram. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
/**
 * Bodies up to this size reach the handler, which refuses the ones over the limit with a 413. Past it, Bun
 * ends the request itself and closes the connection, and cloudflared then reports the unread upload as a 502
 * instead of relaying the 413.
 */
export const MAX_DRAIN_BYTES = 1024 * 1024;
export const RECENT_UPDATE_IDS = 1024;
export const MAX_PENDING_UPDATES = 100;

const { log } = logger.scoped("telegram-webhook");

/**
 * Compares digests, not the strings: `timingSafeEqual` needs equal lengths, and a length check on the
 * raw values would tell a caller how long the secret is.
 */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    const equal = timingSafeEqual(digest(provided ?? ""), digest(expected));

    return equal && expected.length > 0;
}

/** Bounded memory of the update ids already accepted. Telegram sends an update again when it saw no 2xx. */
export class RecentUpdateIds {
    private readonly ids = new Set<number>();
    private readonly capacity: number;

    constructor(capacity: number) {
        this.capacity = capacity;
    }

    /** True the first time an id is seen, false for a repeat. */
    remember(id: number): boolean {
        if (this.ids.has(id)) {
            return false;
        }

        this.ids.add(id);
        if (this.ids.size > this.capacity) {
            const oldest = this.ids.values().next();
            if (!oldest.done) {
                this.ids.delete(oldest.value);
            }
        }

        return true;
    }
}

/** The body as text, or null once it passes `maxBytes`. Stops reading at the limit, so a huge upload is never held. */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        return null;
    }

    const reader = request.body?.getReader();
    if (!reader) {
        return "";
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }

        chunks.push(value);
    }

    return Buffer.concat(chunks).toString("utf8");
}

function isUpdate(value: unknown): value is Update {
    return (
        typeof value === "object" &&
        value !== null &&
        "update_id" in value &&
        typeof value.update_id === "number" &&
        Number.isSafeInteger(value.update_id)
    );
}

function parseUpdate(body: string): Update | null {
    try {
        const parsed: unknown = SafeJSON.parse(body, { strict: true });

        return isUpdate(parsed) ? parsed : null;
    } catch (err) {
        log.debug({ err }, "request body is not JSON");
        return null;
    }
}

export interface WebhookHandlerOptions {
    secret: string;
    /** The only path served. Anything else is a 404. */
    path: string;
    onUpdate: (update: Update) => Promise<void>;
    maxBodyBytes?: number;
    recentCapacity?: number;
    /** Accepted updates still waiting to run. Past it the receiver answers 503 and Telegram sends the update again. */
    maxPending?: number;
}

export interface WebhookHandler {
    handle(request: Request): Promise<Response>;
    /** Settles once every update accepted so far has been handled. */
    idle(): Promise<void>;
}

function respond(status: number, headers?: Record<string, string>): Response {
    return new Response(null, { status, headers });
}

/**
 * The checks run in a fixed order, and every refusal has an empty body, so a caller learns nothing it
 * did not already know: wrong path (404), then the secret (401), then the method (405), the content
 * type (415), the size (413) and the shape (400). A valid update is answered 200 once its body is read and
 * checked, and handled afterwards, one at a time, in the order the bodies finished arriving. Telegram
 * delivers over several connections at once (`max_connections` defaults to 40), so a slow upload can be
 * overtaken by a later update. The receiver does not put updates back in `update_id` order.
 */
export function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
    const maxBodyBytes = options.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;
    const maxPending = options.maxPending ?? MAX_PENDING_UPDATES;
    const recent = new RecentUpdateIds(options.recentCapacity ?? RECENT_UPDATE_IDS);
    let pending = 0;
    let tail: Promise<void> = Promise.resolve();

    const enqueue = (update: Update): void => {
        pending += 1;
        tail = tail.then(async () => {
            try {
                await options.onUpdate(update);
            } catch (err) {
                log.error({ err, updateId: update.update_id }, "the update handler failed");
            } finally {
                pending -= 1;
            }
        });
    };

    return {
        async handle(request) {
            if (new URL(request.url).pathname !== options.path) {
                return respond(404);
            }

            if (!secretMatches(request.headers.get(WEBHOOK_SECRET_HEADER), options.secret)) {
                log.debug({ method: request.method }, "rejected a request without the right secret");
                return respond(401);
            }

            if (request.method !== "POST") {
                return respond(405, { Allow: "POST" });
            }

            if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
                return respond(415);
            }

            const body = await readBodyWithLimit(request, maxBodyBytes);
            if (body === null) {
                log.warn({ maxBodyBytes }, "rejected an authenticated body over the size limit");
                return respond(413);
            }

            const update = parseUpdate(body);
            if (!update) {
                return respond(400);
            }

            if (pending >= maxPending) {
                log.warn({ pending, updateId: update.update_id }, "too many updates waiting, asking Telegram to retry");
                return respond(503, { "Retry-After": "5" });
            }

            if (!recent.remember(update.update_id)) {
                log.debug({ updateId: update.update_id }, "ignored a repeated update");
                return respond(200);
            }

            log.debug({ updateId: update.update_id }, "accepted an update");
            enqueue(update);

            return respond(200);
        },
        idle: () => tail,
    };
}

export interface WebhookServerOptions extends WebhookHandlerOptions {
    port: number;
    /** Loopback by default: only the tunnel's connector on this machine should reach the receiver. */
    hostname?: string;
}

export interface WebhookServer {
    port: number;
    stop(): Promise<void>;
    idle(): Promise<void>;
}

export function startWebhookServer(options: WebhookServerOptions): WebhookServer {
    const handler = createWebhookHandler(options);
    const hostname = options.hostname ?? "127.0.0.1";
    const server = Bun.serve({
        hostname,
        port: options.port,
        maxRequestBodySize: Math.max(MAX_DRAIN_BYTES, options.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES),
        fetch: (request) => handler.handle(request),
        error: (err) => {
            log.error({ err }, "the receiver failed on a request");
            return respond(500);
        },
    });

    log.info({ hostname, port: server.port, path: options.path }, "webhook receiver listening");

    return { port: server.port ?? options.port, stop: () => server.stop(), idle: handler.idle };
}
