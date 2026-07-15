import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { handleStripeEvent } from "@app/youtube/lib/billing";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { Youtube } from "@app/youtube/lib/youtube";

/** Stripe events are small JSON documents — anything past this is abuse. */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Public webhook endpoints — never gated by the service-key auth applied to
 * `/api/v1/*` elsewhere (external providers can't present our key; the
 * request is authenticated by its own signature instead). Registered as an
 * open route in `server/index.ts`.
 */
export async function handleWebhooksRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    if (matchRoute(req, "POST", "/api/v1/webhooks/stripe", url.pathname)) {
        const signature = req.headers.get("Stripe-Signature");

        if (!signature) {
            return jsonError("missing Stripe-Signature header", 400);
        }

        // Signature verification needs the exact bytes Stripe signed — read raw
        // bytes before any JSON parsing (handleStripeEvent parses it internally).
        // The route is public and buffers BEFORE the signature check, so cap the
        // body instead of trusting Content-Length alone.
        const payload = await readBodyCapped(req, MAX_WEBHOOK_BODY_BYTES);

        if (payload === null) {
            return jsonError("payload too large", 413);
        }

        try {
            await handleStripeEvent(yt.db, payload, signature);
            return Response.json({ received: true }, { headers: CORS_HEADERS });
        } catch (error) {
            logger.warn({ error }, "youtube webhooks: stripe event rejected");
            return jsonError(error instanceof Error ? error.message : String(error), 400);
        }
    }

    return jsonError("not found", 404);
}

/** Streams the body up to `maxBytes`; `null` once the cap is crossed. */
async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
    const contentLength = Number(req.headers.get("Content-Length") ?? "0");

    if (contentLength > maxBytes) {
        return null;
    }

    if (!req.body) {
        return "";
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of req.body) {
        total += chunk.byteLength;

        if (total > maxBytes) {
            return null;
        }

        chunks.push(chunk);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
