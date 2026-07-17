import Stripe from "stripe";

/** Per spec, success/cancel both return to YouTube — the extension polls balance; no landing page. */
const CHECKOUT_RETURN_URL = "https://www.youtube.com";

export interface CheckoutSessionResult {
    id: string;
    url: string;
}

export interface PackCheckoutInput {
    priceId: string;
    userId: number;
    packId: string;
}

export interface SubscriptionCheckoutInput {
    priceId: string;
    userId: number;
    planId: string;
}

/** The only seam that talks to Stripe outbound — tests substitute a fake. */
export interface StripeGateway {
    createPackCheckout(input: PackCheckoutInput): Promise<CheckoutSessionResult>;
    createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<CheckoutSessionResult>;
}

export function createStripeGateway(secretKey: string): StripeGateway {
    const stripe = new Stripe(secretKey);

    return {
        async createPackCheckout(input: PackCheckoutInput): Promise<CheckoutSessionResult> {
            const session = await stripe.checkout.sessions.create({
                mode: "payment",
                client_reference_id: String(input.userId),
                line_items: [{ price: input.priceId, quantity: 1 }],
                metadata: { packId: input.packId, userId: String(input.userId) },
                // Session metadata does not propagate to the charge — set it on
                // the PaymentIntent too so charge.refunded can attribute refunds.
                payment_intent_data: { metadata: { packId: input.packId, userId: String(input.userId) } },
                success_url: CHECKOUT_RETURN_URL,
                cancel_url: CHECKOUT_RETURN_URL,
            });

            return toResult(session);
        },
        async createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<CheckoutSessionResult> {
            const session = await stripe.checkout.sessions.create({
                mode: "subscription",
                client_reference_id: String(input.userId),
                line_items: [{ price: input.priceId, quantity: 1 }],
                metadata: { planId: input.planId, userId: String(input.userId) },
                // Propagate onto the Subscription object so invoice.paid and
                // subscription.updated events can attribute without lookups.
                subscription_data: { metadata: { planId: input.planId, userId: String(input.userId) } },
                success_url: CHECKOUT_RETURN_URL,
                cancel_url: CHECKOUT_RETURN_URL,
            });

            return toResult(session);
        },
    };
}

function toResult(session: Stripe.Checkout.Session): CheckoutSessionResult {
    if (!session.url) {
        throw new Error("stripe checkout session response missing url");
    }

    return { id: session.id, url: session.url };
}
