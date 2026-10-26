import { describe, expect, it } from "bun:test";
import {
    createStripeGateway,
    type StripeCheckoutSessionParams,
    type StripeLoader,
} from "@app/youtube/lib/billing-gateway";

/** A loader that installs nothing and returns a fake SDK recording every key and checkout request. */
function fakeLoader(options: { failFirstLoad?: boolean } = {}) {
    const keys: string[] = [];
    const requests: StripeCheckoutSessionParams[] = [];
    let ensures = 0;
    let loads = 0;
    const loader: StripeLoader = {
        ensure: async () => {
            ensures++;
        },
        load: async () => {
            loads++;

            if (options.failFirstLoad && loads === 1) {
                throw new Error("import failed");
            }

            return {
                default: class {
                    checkout = {
                        sessions: {
                            create: async (params: StripeCheckoutSessionParams) => {
                                requests.push(params);
                                return { id: `cs_${requests.length}`, url: `https://checkout.test/${requests.length}` };
                            },
                        },
                    };

                    constructor(secretKey: string) {
                        keys.push(secretKey);
                    }
                },
            };
        },
    };

    return { loader, keys, requests, counts: () => ({ ensures, loads }) };
}

describe("createStripeGateway", () => {
    it("constructs offline and exposes both checkout methods", () => {
        const gateway = createStripeGateway("sk_test_offline_construct_only");

        expect(typeof gateway.createPackCheckout).toBe("function");
        expect(typeof gateway.createSubscriptionCheckout).toBe("function");
    });

    it("loads the SDK once for concurrent checkouts and sends the attribution metadata", async () => {
        const fake = fakeLoader();
        const gateway = createStripeGateway("sk_test_key", fake.loader);

        const [pack, subscription] = await Promise.all([
            gateway.createPackCheckout({ priceId: "price_pack", userId: 7, packId: "pack_1" }),
            gateway.createSubscriptionCheckout({ priceId: "price_plan", userId: 7, planId: "plan_1" }),
        ]);

        expect(fake.counts()).toEqual({ ensures: 1, loads: 1 });
        expect(fake.keys).toEqual(["sk_test_key"]);
        expect([pack.id, subscription.id]).toEqual(["cs_1", "cs_2"]);
        expect(fake.requests[0]).toMatchObject({
            mode: "payment",
            client_reference_id: "7",
            line_items: [{ price: "price_pack", quantity: 1 }],
            payment_intent_data: { metadata: { packId: "pack_1", userId: "7" } },
        });
        expect(fake.requests[1]).toMatchObject({
            mode: "subscription",
            subscription_data: { metadata: { planId: "plan_1", userId: "7" } },
        });
    });

    it("retries the load on the next checkout after a failed import", async () => {
        const fake = fakeLoader({ failFirstLoad: true });
        const gateway = createStripeGateway("sk_test_key", fake.loader);
        const input = { priceId: "price_pack", userId: 1, packId: "pack_1" };

        await expect(gateway.createPackCheckout(input)).rejects.toThrow("import failed");
        await expect(gateway.createPackCheckout(input)).resolves.toEqual({
            id: "cs_1",
            url: "https://checkout.test/1",
        });
        expect(fake.counts()).toEqual({ ensures: 2, loads: 2 });
    });
});
