import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { handleStripeEvent } from "@app/youtube/lib/billing";
import { YoutubeDatabase } from "@app/youtube/lib/db";

const SECRET = "whsec_p2_tests";
let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

function signPayload(secret: string, payloadObj: unknown): { payload: string; signature: string } {
    const payload = SafeJSON.stringify(payloadObj, { strict: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");

    return { payload, signature: `t=${timestamp},v1=${sig}` };
}

async function deliver(eventObj: unknown): Promise<void> {
    const { payload, signature } = signPayload(SECRET, eventObj);

    await env.testing.withOverrides({ STRIPE_WEBHOOK_SECRET: SECRET }, async () => {
        await handleStripeEvent(db, payload, signature);
    });
}

function subCheckoutEvent(userId: number, eventId = "evt_co_1") {
    return {
        id: eventId,
        type: "checkout.session.completed",
        data: {
            object: {
                id: "cs_sub_1",
                mode: "subscription",
                customer: "cus_1",
                subscription: "sub_1",
                client_reference_id: String(userId),
                metadata: { planId: "sub-monthly", userId: String(userId) },
            },
        },
    };
}

function invoicePaidEvent(eventId: string, invoiceId: string, periodStartSec: number, periodEndSec: number) {
    return {
        id: eventId,
        type: "invoice.paid",
        data: {
            object: {
                id: invoiceId,
                subscription: "sub_1",
                amount_paid: 999,
                currency: "usd",
                lines: { data: [{ period: { start: periodStartSec, end: periodEndSec } }] },
            },
        },
    };
}

describe("subscription webhook lifecycle", () => {
    it("checkout.session.completed (subscription) creates the subscription row", async () => {
        const user = db.createUser({ email: "w@example.com", passwordHash: "h", apiToken: "ytu_w" });
        await deliver(subCheckoutEvent(user.id));
        const sub = db.getSubscriptionByUserId(user.id);

        expect(sub?.stripeSubscriptionId).toBe("sub_1");
        expect(sub?.status).toBe("active");
        expect(sub?.periodStart).toBeNull();
        expect(db.getWebhookLog("evt_co_1")?.outcome).toBe("processed");
    });

    it("first invoice.paid grants the allowance additively; renewal resets instead of stacking", async () => {
        const user = db.createUser({ email: "w2@example.com", passwordHash: "h", apiToken: "ytu_w2" });
        db.grantCredits(user.id, 100, "register-grant");
        await deliver(subCheckoutEvent(user.id));
        // Period start sits an hour AFTER the register-grant ledger row: the
        // renewal's getGrantsSince(periodStart) must not re-count pre-period
        // grants (they are already inside period_start_balance). Same-second
        // timestamps would double-count and break the reset assertion.
        const periodStartSec = Math.floor(Date.now() / 1000) + 3600;

        await deliver(invoicePaidEvent("evt_inv_1", "in_1", periodStartSec, periodStartSec + 2_592_000));
        expect(db.getUserCredits(user.id)).toBe(3100);

        db.spendCredits(user.id, 1200, "ask");
        await deliver(invoicePaidEvent("evt_inv_2", "in_2", periodStartSec + 2_592_000, periodStartSec + 5_184_000));
        // Reset, not additive: topup remainder (100) + fresh allowance (3000).
        expect(db.getUserCredits(user.id)).toBe(3100);
        expect(db.listPayments({ userId: user.id })).toHaveLength(2);
    });

    it("is idempotent across exact redelivery AND distinct events for the same invoice", async () => {
        const user = db.createUser({ email: "w3@example.com", passwordHash: "h", apiToken: "ytu_w3" });
        await deliver(subCheckoutEvent(user.id));
        const nowSec = Math.floor(Date.now() / 1000);

        await deliver(invoicePaidEvent("evt_inv_a", "in_x", nowSec, nowSec + 2_592_000));
        await deliver(invoicePaidEvent("evt_inv_a", "in_x", nowSec, nowSec + 2_592_000));
        await deliver(invoicePaidEvent("evt_inv_b", "in_x", nowSec, nowSec + 2_592_000));
        expect(db.getUserCredits(user.id)).toBe(3000);
    });

    it("invoice.payment_failed marks past_due and records a failed payment", async () => {
        const user = db.createUser({ email: "w4@example.com", passwordHash: "h", apiToken: "ytu_w4" });
        await deliver(subCheckoutEvent(user.id));
        await deliver({
            id: "evt_fail_1",
            type: "invoice.payment_failed",
            data: { object: { id: "in_fail", subscription: "sub_1", amount_due: 999, currency: "usd" } },
        });

        expect(db.getSubscriptionByUserId(user.id)?.status).toBe("past_due");
        expect(db.listPayments({ userId: user.id })[0]?.status).toBe("failed");
    });

    it("customer.subscription.updated + deleted track status", async () => {
        const user = db.createUser({ email: "w5@example.com", passwordHash: "h", apiToken: "ytu_w5" });
        await deliver(subCheckoutEvent(user.id));
        await deliver({
            id: "evt_upd_1",
            type: "customer.subscription.updated",
            data: {
                object: {
                    id: "sub_1",
                    status: "active",
                    cancel_at_period_end: true,
                    current_period_end: 1_800_000_000,
                },
            },
        });

        expect(db.getSubscriptionByUserId(user.id)?.cancelAtPeriodEnd).toBe(true);

        await deliver({
            id: "evt_del_1",
            type: "customer.subscription.deleted",
            data: { object: { id: "sub_1", status: "canceled" } },
        });
        expect(db.getSubscriptionByUserId(user.id)?.status).toBe("canceled");
    });

    it("unhandled event types log outcome skipped", async () => {
        await deliver({ id: "evt_misc", type: "customer.created", data: { object: {} } });
        expect(db.getWebhookLog("evt_misc")?.outcome).toBe("skipped");
    });
});

function packCheckoutEvent(opts: {
    userId: number;
    eventId?: string;
    sessionId?: string;
    paymentStatus?: string;
    type?: string;
    packId?: string;
}) {
    return {
        id: opts.eventId ?? "evt_pack_1",
        type: opts.type ?? "checkout.session.completed",
        data: {
            object: {
                id: opts.sessionId ?? "cs_pack_1",
                mode: "payment",
                payment_status: opts.paymentStatus,
                amount_total: 1499,
                currency: "usd",
                metadata: { packId: opts.packId ?? "pack-medium", userId: String(opts.userId) },
            },
        },
    };
}

describe("pack checkout fulfillment gating (payment_status)", () => {
    it("grants diamonds only when payment_status is paid", async () => {
        const user = db.createUser({ email: "p@example.com", passwordHash: "h", apiToken: "ytu_p" });
        await deliver(packCheckoutEvent({ userId: user.id, paymentStatus: "paid" }));

        expect(db.getUserCredits(user.id)).toBe(2000);
        expect(db.getWebhookLog("evt_pack_1")?.outcome).toBe("processed");
    });

    it("does not grant on an unpaid completed session (delayed payment method)", async () => {
        const user = db.createUser({ email: "p2@example.com", passwordHash: "h", apiToken: "ytu_p2" });
        await deliver(
            packCheckoutEvent({ userId: user.id, paymentStatus: "unpaid", eventId: "evt_unpaid", sessionId: "cs_late" })
        );

        expect(db.getUserCredits(user.id)).toBe(0);
        expect(db.getWebhookLog("evt_unpaid")?.outcome).toBe("skipped");
        expect(db.hasLedgerReason(user.id, "stripe:cs_late")).toBe(false);
    });

    it("checkout.session.async_payment_succeeded fulfills a later-paid session", async () => {
        const user = db.createUser({ email: "p3@example.com", passwordHash: "h", apiToken: "ytu_p3" });
        // Delayed method: completed first (unpaid, no grant), then async succeeded (paid).
        await deliver(
            packCheckoutEvent({ userId: user.id, paymentStatus: "unpaid", eventId: "evt_c", sessionId: "cs_async" })
        );
        expect(db.getUserCredits(user.id)).toBe(0);

        await deliver(
            packCheckoutEvent({
                userId: user.id,
                paymentStatus: "paid",
                eventId: "evt_async",
                sessionId: "cs_async",
                type: "checkout.session.async_payment_succeeded",
            })
        );

        expect(db.getUserCredits(user.id)).toBe(2000);
        expect(db.hasLedgerReason(user.id, "stripe:cs_async")).toBe(true);
    });
});

function refundEvent(opts: {
    userId: number;
    eventId?: string;
    chargeId?: string;
    amount?: number;
    amountRefunded?: number;
    packId?: string;
}) {
    return {
        id: opts.eventId ?? "evt_refund_1",
        type: "charge.refunded",
        data: {
            object: {
                id: opts.chargeId ?? "ch_1",
                amount: opts.amount,
                amount_refunded: opts.amountRefunded,
                metadata: { packId: opts.packId ?? "pack-medium", userId: String(opts.userId) },
            },
        },
    };
}

describe("charge.refunded partial vs full", () => {
    it("full refund claws back the whole pack", async () => {
        const user = db.createUser({ email: "r@example.com", passwordHash: "h", apiToken: "ytu_r" });
        db.grantCredits(user.id, 2000, "stripe:cs_r");
        await deliver(refundEvent({ userId: user.id, amount: 1499, amountRefunded: 1499 }));

        expect(db.getUserCredits(user.id)).toBe(0);
    });

    it("partial refund claws back only the proportional (floored) diamonds", async () => {
        const user = db.createUser({ email: "r2@example.com", passwordHash: "h", apiToken: "ytu_r2" });
        db.grantCredits(user.id, 2000, "stripe:cs_r2");
        // 500/1499 of a 2000-diamond pack → floor(2000 * 500 / 1499) = 667 reversed.
        await deliver(
            refundEvent({
                userId: user.id,
                eventId: "evt_partial",
                chargeId: "ch_2",
                amount: 1499,
                amountRefunded: 500,
            })
        );

        expect(db.getUserCredits(user.id)).toBe(2000 - 667);
    });
});
