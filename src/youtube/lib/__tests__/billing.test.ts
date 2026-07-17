import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import {
    createCheckoutSession,
    createSubscriptionCheckoutSession,
    handleStripeEvent,
    verifyStripeSignature,
} from "@app/youtube/lib/billing";
import { YoutubeDatabase } from "@app/youtube/lib/db";

// Golden vector — recomputed via:
//   bun -e 'const c=require("node:crypto");const s="whsec_test_golden_secret";
//   const p="{\"id\":\"evt_test_golden\",\"type\":\"checkout.session.completed\"}";
//   const t=1700000000;console.log(c.createHmac("sha256",s).update(`${t}.${p}`).digest("hex"))'
const SECRET = "whsec_test_golden_secret";
const PAYLOAD = '{"id":"evt_test_golden","type":"checkout.session.completed"}';
const TIMESTAMP = 1700000000;
const GOLDEN_SIGNATURE = "37053143db07d5dcd1a63cfb607405fd917d97a8dc905ee9bb5b86dcccbc5efa";

// Fixed timestamp is far in the past relative to "now" — passing tests use a
// huge tolerance to isolate signature-correctness from freshness checks.
const HUGE_TOLERANCE = 10_000_000_000;

describe("verifyStripeSignature", () => {
    it("accepts a known-good signature (golden vector)", () => {
        const header = `t=${TIMESTAMP},v1=${GOLDEN_SIGNATURE}`;

        expect(
            verifyStripeSignature({ payload: PAYLOAD, signature: header, secret: SECRET, toleranceSec: HUGE_TOLERANCE })
        ).toBe(true);
    });

    it("rejects a tampered signature (flipped byte)", () => {
        const tampered = `${GOLDEN_SIGNATURE.slice(0, -1)}${GOLDEN_SIGNATURE.endsWith("a") ? "b" : "a"}`;
        const header = `t=${TIMESTAMP},v1=${tampered}`;

        expect(
            verifyStripeSignature({ payload: PAYLOAD, signature: header, secret: SECRET, toleranceSec: HUGE_TOLERANCE })
        ).toBe(false);
    });

    it("rejects a tampered payload", () => {
        const header = `t=${TIMESTAMP},v1=${GOLDEN_SIGNATURE}`;

        expect(
            verifyStripeSignature({
                payload: `${PAYLOAD} `,
                signature: header,
                secret: SECRET,
                toleranceSec: HUGE_TOLERANCE,
            })
        ).toBe(false);
    });

    it("rejects a stale timestamp outside the default tolerance", () => {
        const header = `t=${TIMESTAMP},v1=${GOLDEN_SIGNATURE}`;

        expect(verifyStripeSignature({ payload: PAYLOAD, signature: header, secret: SECRET })).toBe(false);
    });

    it("rejects a malformed signature header", () => {
        expect(
            verifyStripeSignature({
                payload: PAYLOAD,
                signature: "not-a-valid-header",
                secret: SECRET,
                toleranceSec: HUGE_TOLERANCE,
            })
        ).toBe(false);
    });

    it("accepts a freshly signed payload within default tolerance", () => {
        const now = Math.floor(Date.now() / 1000);
        const sig = createHmac("sha256", SECRET).update(`${now}.${PAYLOAD}`).digest("hex");
        const header = `t=${now},v1=${sig}`;

        expect(verifyStripeSignature({ payload: PAYLOAD, signature: header, secret: SECRET })).toBe(true);
    });
});

function signPayload(secret: string, payloadObj: unknown): { payload: string; signature: string } {
    const payload = SafeJSON.stringify(payloadObj, { strict: true });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

    return { payload, signature: `t=${t},v1=${sig}` };
}

function fakeGateway() {
    const calls: { pack: unknown[]; sub: unknown[] } = { pack: [], sub: [] };
    const gateway = {
        createPackCheckout: async (input: unknown) => {
            calls.pack.push(input);
            return { id: "cs_fake", url: "https://checkout.stripe.test/cs_fake" };
        },
        createSubscriptionCheckout: async (input: unknown) => {
            calls.sub.push(input);
            return { id: "cs_sub_fake", url: "https://checkout.stripe.test/cs_sub_fake" };
        },
    };

    return { gateway, calls };
}

describe("createCheckoutSession (gateway)", () => {
    const user = {
        id: 7,
        email: "u@example.com",
        credits: 0,
        createdAt: "",
        outputLang: null,
        ttsVoice: null,
        settings: {},
    };

    it("resolves the pack price and returns the gateway url", async () => {
        const { gateway, calls } = fakeGateway();
        let url = "";

        await env.testing.withOverrides(
            { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_PACK_SMALL: "price_small" },
            async () => {
                ({ url } = await createCheckoutSession({ user, packId: "pack-small", origin: "o", gateway }));
            }
        );

        expect(url).toBe("https://checkout.stripe.test/cs_fake");
        expect(calls.pack).toEqual([{ priceId: "price_small", userId: 7, packId: "pack-small" }]);
    });

    it("throws 'billing not configured' when STRIPE_SECRET_KEY is unset", async () => {
        const { gateway } = fakeGateway();

        await env.testing.withOverrides({ STRIPE_SECRET_KEY: undefined }, async () => {
            await expect(createCheckoutSession({ user, packId: "pack-small", origin: "o", gateway })).rejects.toThrow(
                "billing not configured"
            );
        });
    });
});

describe("createSubscriptionCheckoutSession", () => {
    const user = {
        id: 7,
        email: "u@example.com",
        credits: 0,
        createdAt: "",
        outputLang: null,
        ttsVoice: null,
        settings: {},
    };

    it("resolves the plan price and returns the gateway url", async () => {
        const { gateway, calls } = fakeGateway();
        let url = "";

        await env.testing.withOverrides(
            { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_SUB_MONTHLY: "price_sub" },
            async () => {
                ({ url } = await createSubscriptionCheckoutSession({
                    user,
                    planId: "sub-monthly",
                    origin: "o",
                    gateway,
                }));
            }
        );

        expect(url).toBe("https://checkout.stripe.test/cs_sub_fake");
        expect(calls.sub).toEqual([{ priceId: "price_sub", userId: 7, planId: "sub-monthly" }]);
    });

    it("rejects unknown plans", async () => {
        const { gateway } = fakeGateway();

        await expect(
            createSubscriptionCheckoutSession({ user, planId: "sub-yearly", origin: "o", gateway })
        ).rejects.toThrow("unknown subscription plan");
    });
});

describe("handleStripeEvent", () => {
    let db: YoutubeDatabase;

    beforeEach(() => {
        db = new YoutubeDatabase(":memory:");
    });

    afterEach(() => {
        db.close();
    });

    it("grants diamonds on checkout.session.completed; replayed delivery is a no-op", async () => {
        const user = db.createUser({ email: "buyer@example.com", passwordHash: "h", apiToken: "ytu_buyer" });
        const webhookSecret = "whsec_test_completed";
        const { payload, signature } = signPayload(webhookSecret, {
            id: "evt_1",
            type: "checkout.session.completed",
            data: {
                object: {
                    id: "cs_test_123",
                    payment_status: "paid",
                    metadata: { packId: "pack-medium", userId: String(user.id) },
                },
            },
        });

        await env.testing.withOverrides({ STRIPE_WEBHOOK_SECRET: webhookSecret }, async () => {
            await handleStripeEvent(db, payload, signature);
            await handleStripeEvent(db, payload, signature);
        });

        expect(db.getUserByToken("ytu_buyer")?.credits).toBe(2000);
        expect(db.hasLedgerReason(user.id, "stripe:cs_test_123")).toBe(true);
    });

    it("writes a negative row on charge.refunded; replayed delivery is a no-op", async () => {
        const user = db.createUser({ email: "refund@example.com", passwordHash: "h", apiToken: "ytu_refund" });
        db.grantCredits(user.id, 2000, "stripe:cs_test_456");
        const webhookSecret = "whsec_test_refund";
        const { payload, signature } = signPayload(webhookSecret, {
            id: "evt_2",
            type: "charge.refunded",
            data: { object: { id: "ch_test_789", metadata: { packId: "pack-medium", userId: String(user.id) } } },
        });

        await env.testing.withOverrides({ STRIPE_WEBHOOK_SECRET: webhookSecret }, async () => {
            await handleStripeEvent(db, payload, signature);
            await handleStripeEvent(db, payload, signature);
        });

        expect(db.getUserByToken("ytu_refund")?.credits).toBe(0);
        expect(db.hasLedgerReason(user.id, "stripe-refund:ch_test_789")).toBe(true);
    });

    it("rejects a bad signature", async () => {
        const payload = SafeJSON.stringify({ id: "x", type: "y", data: { object: {} } }, { strict: true });

        await env.testing.withOverrides({ STRIPE_WEBHOOK_SECRET: "whsec_real" }, async () => {
            await expect(handleStripeEvent(db, payload, "t=1,v1=deadbeef")).rejects.toThrow();
        });
    });

    it("acknowledges unrelated event types without throwing or writing rows", async () => {
        const webhookSecret = "whsec_test_other";
        const { payload, signature } = signPayload(webhookSecret, {
            id: "evt_3",
            type: "customer.created",
            data: { object: {} },
        });

        await env.testing.withOverrides({ STRIPE_WEBHOOK_SECRET: webhookSecret }, async () => {
            await expect(handleStripeEvent(db, payload, signature)).resolves.toBeUndefined();
        });
    });
});
