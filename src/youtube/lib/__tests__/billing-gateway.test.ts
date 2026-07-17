import { describe, expect, it } from "bun:test";
import { createStripeGateway } from "@app/youtube/lib/billing-gateway";

describe("createStripeGateway", () => {
    it("constructs offline and exposes both checkout methods", () => {
        const gateway = createStripeGateway("sk_test_offline_construct_only");

        expect(typeof gateway.createPackCheckout).toBe("function");
        expect(typeof gateway.createSubscriptionCheckout).toBe("function");
    });
});
