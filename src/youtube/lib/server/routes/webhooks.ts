import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { handleStripeEvent } from "@app/youtube/lib/billing";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { Youtube } from "@app/youtube/lib/youtube";

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
        // text before any JSON parsing (handleStripeEvent parses it internally).
        const payload = await req.text();

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

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
