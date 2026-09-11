import { createFileRoute } from "@tanstack/react-router";
import type Stripe from "stripe";
import { constructWebhookEvent } from "@/lib/billing/stripe";
import { handleEvent } from "@/lib/billing/subscription-events";

/**
 * Stripe webhook receiver. Verifies the signature against the RAW body, then maps subscription
 * lifecycle events onto the account's subscription row. Inert when Stripe is unconfigured
 * (constructWebhookEvent returns null → 200 ack so Stripe doesn't retry forever in a dev env).
 */
export const Route = createFileRoute("/api/stripe/webhook")({
    server: {
        handlers: {
            POST: async ({ request }) => {
                const payload = await request.text();
                const signature = request.headers.get("stripe-signature");

                let event: Stripe.Event | null;

                try {
                    event = constructWebhookEvent(payload, signature);
                } catch (err) {
                    return Response.json(
                        {
                            error: `Webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
                        },
                        { status: 400 }
                    );
                }

                if (!event) {
                    // Billing not configured (or no signature) — acknowledge without acting.
                    return Response.json({ received: true, configured: false });
                }

                await handleEvent(event);
                return Response.json({ received: true });
            },
        },
    },
});

