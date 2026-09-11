/**
 * Stripe subscription lifecycle → the account's subscription row. Lives here rather than inside the
 * webhook route so the state transitions are unit-testable without standing up a router or a
 * signed request; the route stays a thin adapter that verifies the signature and delegates.
 */

import type Stripe from "stripe";
import { cloudStore } from "@/lib/db/cloud-store";

export async function handleEvent(event: Stripe.Event): Promise<void> {
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
            // Metadata first, then the stored Stripe id. The fallback matters for subscriptions this
            // code did not create (the Stripe dashboard, the billing portal, an import) and for every
            // subscription created before `subscription_data.metadata` was set on checkout.
            const accountId =
                subscription.metadata?.accountId ??
                (await cloudStore.getSubscriptionByStripeId(subscription.id))?.accountId;

            if (accountId) {
                const status =
                    event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(subscription.status);
                await cloudStore.updateSubscription(accountId, {
                    status,
                    tier: event.type === "customer.subscription.deleted" ? "free" : undefined,
                });
            } else {
                // Silence here is how a cancellation goes unnoticed: the route still answers 200, so
                // Stripe records a successful delivery and never retries.
                console.warn(
                    `[stripe] ${event.type} for subscription ${subscription.id} matched no account; metadata=`,
                    subscription.metadata
                );
            }

            break;
        }

        default:
            // Other events are not relevant to the subscription row; ignore.
            break;
    }
}

/**
 * Every `Stripe.Subscription.Status` is listed on purpose. A default that fell through to "active"
 * would ENTITLE an account whose payment never completed or whose subscription is paused, so an
 * unrecognized status is treated as not-entitled instead.
 */
export function mapStatus(stripeStatus: Stripe.Subscription.Status): "active" | "trialing" | "past_due" | "canceled" {
    switch (stripeStatus) {
        case "active":
            return "active";
        case "trialing":
            return "trialing";
        case "past_due":
        case "unpaid":
        case "incomplete":
        case "paused":
            return "past_due";
        case "canceled":
        case "incomplete_expired":
            return "canceled";
        default:
            return "canceled";
    }
}
