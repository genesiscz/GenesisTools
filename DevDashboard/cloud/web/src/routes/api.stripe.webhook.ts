import { createFileRoute } from "@tanstack/react-router";
import type Stripe from "stripe";
import { constructWebhookEvent } from "@/lib/billing/stripe";
import { cloudStore } from "@/lib/db/cloud-store";

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

async function handleEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
        case "checkout.session.completed": {
            const session = event.data.object;
            const accountId = session.client_reference_id ?? session.metadata?.accountId;
            const tier = session.metadata?.tier;

            if (accountId && (tier === "pro" || tier === "team")) {
                await cloudStore.updateSubscription(accountId, {
                    tier,
                    status: "active",
                    stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
                    stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : null,
                });
            }

            break;
        }

        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
            const subscription = event.data.object;
            const accountId = subscription.metadata?.accountId;

            if (accountId) {
                const status =
                    event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(subscription.status);
                await cloudStore.updateSubscription(accountId, {
                    status,
                    tier: event.type === "customer.subscription.deleted" ? "free" : undefined,
                });
            }

            break;
        }

        default:
            // Other events are not relevant to the subscription row; ignore.
            break;
    }
}

function mapStatus(stripeStatus: Stripe.Subscription.Status): "active" | "trialing" | "past_due" | "canceled" {
    switch (stripeStatus) {
        case "trialing":
            return "trialing";
        case "past_due":
        case "unpaid":
            return "past_due";
        case "canceled":
        case "incomplete_expired":
            return "canceled";
        default:
            return "active";
    }
}
