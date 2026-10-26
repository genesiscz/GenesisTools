import { importStorePackage } from "@genesiscz/utils/package-store";
import { ensurePackage } from "@genesiscz/utils/packages";

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

/**
 * The part of the Stripe SDK this file calls. The SDK is a package-store package (src/utils/package-store.ts),
 * installed on the first checkout, not a repo dependency: its 228 declaration files (5.9 MB) were about 6% of every
 * TypeScript program that holds the youtube server, for this one file (2026-10-25).
 */
export interface StripeCheckoutSessionParams {
    mode: "payment" | "subscription";
    client_reference_id: string;
    line_items: Array<{ price: string; quantity: number }>;
    metadata: Record<string, string>;
    payment_intent_data?: { metadata: Record<string, string> };
    subscription_data?: { metadata: Record<string, string> };
    success_url: string;
    cancel_url: string;
}

export interface StripeCheckoutSession {
    id: string;
    url: string | null;
}

export interface StripeClient {
    checkout: { sessions: { create(params: StripeCheckoutSessionParams): Promise<StripeCheckoutSession> } };
}

export interface StripeModule {
    default: new (secretKey: string) => StripeClient;
}

/** How the SDK reaches the process; tests pass fakes so no package is installed and Stripe is never called. */
export interface StripeLoader {
    ensure: (name: string, options: { label: string }) => Promise<void>;
    load: (name: string) => Promise<StripeModule>;
}

const storeLoader: StripeLoader = {
    ensure: ensurePackage,
    load: (name) => importStorePackage<StripeModule>(name),
};

async function loadStripe(secretKey: string, loader: StripeLoader): Promise<StripeClient> {
    await loader.ensure("stripe", { label: "Stripe SDK (youtube checkout)" });
    const { default: Stripe } = await loader.load("stripe");
    return new Stripe(secretKey);
}

export function createStripeGateway(secretKey: string, loader: StripeLoader = storeLoader): StripeGateway {
    let client: Promise<StripeClient> | undefined;
    // Loaded on the first checkout; a failed install or import is retried by the next one.
    const stripe = () =>
        (client ??= loadStripe(secretKey, loader).catch((err: unknown) => {
            client = undefined;
            throw err;
        }));

    return {
        async createPackCheckout(input: PackCheckoutInput): Promise<CheckoutSessionResult> {
            const session = await (await stripe()).checkout.sessions.create({
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
            const session = await (await stripe()).checkout.sessions.create({
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

function toResult(session: StripeCheckoutSession): CheckoutSessionResult {
    if (!session.url) {
        throw new Error("stripe checkout session response missing url");
    }

    return { id: session.id, url: session.url };
}
