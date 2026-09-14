/**
 * Server functions backing the Billing page. Env-gated: when Stripe is unconfigured these return
 * a "not configured" result the UI surfaces, instead of crashing.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authService } from "@/lib/auth/auth-service";
import { cloudStore } from "@/lib/db/cloud-store";
import { getCloudEnv } from "@/lib/server/env";
import { createCheckoutSession, createPortalSession, isBillingConfigured } from "./stripe";

async function currentUser() {
    const request = getRequest();
    return authService.requireAuth(request.headers);
}

export const getBilling = createServerFn({ method: "GET" }).handler(async () => {
    const user = await currentUser();
    const subscription = await cloudStore.ensureSubscription(user.id);

    return {
        configured: isBillingConfigured(),
        tier: subscription.tier,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        hasStripeCustomer: subscription.stripeCustomerId !== null,
    };
});

const checkoutInput = z.object({ tier: z.enum(["pro", "team"]) });

export const startCheckout = createServerFn({ method: "POST" })
    .inputValidator(checkoutInput)
    .handler(async ({ data }) => {
        const user = await currentUser();
        const subscription = await cloudStore.ensureSubscription(user.id);
        const env = getCloudEnv();

        const result = await createCheckoutSession({
            tier: data.tier,
            accountId: user.id,
            email: user.email,
            appBaseUrl: env.appBaseUrl,
            existingCustomerId: subscription.stripeCustomerId,
        });

        return result;
    });

export const openBillingPortal = createServerFn({ method: "POST" }).handler(async () => {
    const user = await currentUser();
    const subscription = await cloudStore.ensureSubscription(user.id);
    const env = getCloudEnv();

    if (!subscription.stripeCustomerId) {
        return { configured: isBillingConfigured(), url: null, note: "No Stripe customer yet — start a plan first." };
    }

    return createPortalSession({ customerId: subscription.stripeCustomerId, appBaseUrl: env.appBaseUrl });
});
