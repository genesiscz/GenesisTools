/**
 * Stripe billing — REAL code paths, ENV-GATED (inert without creds). SERVER-ONLY.
 *
 * The Stripe client is lazy-initialised behind getStripeEnv() (server/lib/env.ts). With no
 * STRIPE_SECRET_KEY present, every entry point returns a `{ configured: false }` result and the
 * caller stubs gracefully — the server boots and the Billing page renders a "not configured" state.
 * With env present, this creates real Checkout sessions and verifies real webhook signatures.
 *
 * NOTHING here is constructed at module load — `getStripe()` builds the client on first use only.
 */

import Stripe from "stripe";
import { getStripeEnv } from "@/lib/server/env";

let cached: Stripe | null = null;

/** Returns the Stripe client, or null when STRIPE_SECRET_KEY is unset (billing inert). */
export function getStripe(): Stripe | null {
    const env = getStripeEnv();

    if (!env) {
        return null;
    }

    if (!cached) {
        cached = new Stripe(env.secretKey, { apiVersion: "2025-08-27.basil" });
    }

    return cached;
}

export function isBillingConfigured(): boolean {
    return getStripeEnv() !== null;
}

export type PaidTier = "pro" | "team";

function priceIdFor(tier: PaidTier): string | undefined {
    const env = getStripeEnv();

    if (!env) {
        return undefined;
    }

    return tier === "pro" ? (env.priceProYearly ?? env.priceProMonthly) : env.priceTeamMonthly;
}

export interface CheckoutResult {
    configured: boolean;
    url: string | null;
    note?: string;
}

/**
 * Create a Stripe Checkout session for a paid tier. Inert (configured:false) without creds.
 */
export async function createCheckoutSession(opts: {
    tier: PaidTier;
    accountId: string;
    email: string;
    appBaseUrl: string;
    existingCustomerId: string | null;
}): Promise<CheckoutResult> {
    const stripe = getStripe();

    if (!stripe) {
        return {
            configured: false,
            url: null,
            note: "Stripe is not configured (STRIPE_SECRET_KEY unset). Checkout is disabled in this environment.",
        };
    }

    const price = priceIdFor(opts.tier);

    if (!price) {
        return {
            configured: true,
            url: null,
            note: `No Stripe price id configured for the ${opts.tier} tier (set STRIPE_PRICE_${opts.tier.toUpperCase()}_*).`,
        };
    }

    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        customer: opts.existingCustomerId ?? undefined,
        customer_email: opts.existingCustomerId ? undefined : opts.email,
        client_reference_id: opts.accountId,
        metadata: { accountId: opts.accountId, tier: opts.tier },
        success_url: `${opts.appBaseUrl}/dashboard/billing?status=success`,
        cancel_url: `${opts.appBaseUrl}/dashboard/billing?status=cancelled`,
    });

    return { configured: true, url: session.url };
}

export interface PortalResult {
    configured: boolean;
    url: string | null;
    note?: string;
}

/** Create a Stripe billing-portal session so the customer can manage/cancel. Inert without creds. */
export async function createPortalSession(opts: { customerId: string; appBaseUrl: string }): Promise<PortalResult> {
    const stripe = getStripe();

    if (!stripe) {
        return { configured: false, url: null, note: "Stripe is not configured." };
    }

    const session = await stripe.billingPortal.sessions.create({
        customer: opts.customerId,
        return_url: `${opts.appBaseUrl}/dashboard/billing`,
    });

    return { configured: true, url: session.url };
}

/**
 * Verify a Stripe webhook signature and return the parsed event, or null when billing is inert /
 * the signature is missing. Throws when configured AND the signature is invalid (tamper).
 */
export function constructWebhookEvent(payload: string, signature: string | null): Stripe.Event | null {
    const stripe = getStripe();
    const env = getStripeEnv();

    if (!stripe || !env?.webhookSecret || !signature) {
        return null;
    }

    return stripe.webhooks.constructEvent(payload, signature, env.webhookSecret);
}
