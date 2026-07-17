import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

function ledgerRowCount(db: YoutubeDatabase, userId: number, reason: string): number {
    const row = db
        .getDb()
        .query<{ count: number }, [number, string]>(
            "SELECT COUNT(*) AS count FROM credit_ledger WHERE user_id = ? AND reason = ?"
        )
        .get(userId, reason);

    return row?.count ?? 0;
}

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("subscriptions", () => {
    it("upserts by user and reads back by user and stripe id", () => {
        const created = db.upsertSubscription({
            userId: 7,
            stripeCustomerId: "cus_1",
            stripeSubscriptionId: "sub_1",
            planId: "sub-monthly",
            status: "active",
            allowance: 3000,
            periodStartBalance: 100,
        });

        expect(created.status).toBe("active");
        expect(db.getSubscriptionByUserId(7)?.stripeSubscriptionId).toBe("sub_1");
        expect(db.getSubscriptionByStripeId("sub_1")?.userId).toBe(7);

        const again = db.upsertSubscription({
            userId: 7,
            stripeCustomerId: "cus_1",
            stripeSubscriptionId: "sub_1",
            planId: "sub-monthly",
            status: "past_due",
            allowance: 3000,
        });

        expect(again.id).toBe(created.id);
        expect(db.getSubscriptionByUserId(7)?.status).toBe("past_due");
    });

    it("applies partial updates", () => {
        const sub = db.upsertSubscription({ userId: 8, planId: "sub-monthly", status: "active", allowance: 3000 });
        db.updateSubscription(sub.id, {
            status: "canceled",
            cancelAtPeriodEnd: true,
            periodEnd: "2026-08-01T00:00:00.000Z",
        });
        const read = db.getSubscriptionByUserId(8);

        expect(read?.status).toBe("canceled");
        expect(read?.cancelAtPeriodEnd).toBe(true);
        expect(read?.periodEnd).toBe("2026-08-01T00:00:00.000Z");
    });
});

describe("payments + webhook logs", () => {
    it("payments are replay-safe on stripe_ref", () => {
        db.recordPayment({
            userId: 7,
            kind: "pack",
            stripeRef: "cs_1",
            packId: "pack-small",
            amountCents: 499,
            currency: "usd",
            credits: 500,
            status: "succeeded",
        });
        db.recordPayment({
            userId: 7,
            kind: "pack",
            stripeRef: "cs_1",
            packId: "pack-small",
            amountCents: 499,
            currency: "usd",
            credits: 500,
            status: "succeeded",
        });

        expect(db.listPayments({ userId: 7 })).toHaveLength(1);
    });

    it("webhook logs upsert on event id", () => {
        db.recordWebhookLog({
            stripeEventId: "evt_1",
            type: "invoice.paid",
            payloadHash: "aa",
            outcome: "error",
            detail: "boom",
        });
        db.recordWebhookLog({ stripeEventId: "evt_1", type: "invoice.paid", payloadHash: "aa", outcome: "processed" });
        const log = db.getWebhookLog("evt_1");

        expect(log?.outcome).toBe("processed");
        expect(log?.detail).toBeNull();
        expect(db.getWebhookLog("evt_missing")).toBeNull();
    });
});

describe("quota + grants", () => {
    it("increments quota until the limit, then denies without incrementing", () => {
        expect(db.incrementQuotaIfBelow(7, "2026-07", 2)).toEqual({ allowed: true, used: 1 });
        expect(db.incrementQuotaIfBelow(7, "2026-07", 2)).toEqual({ allowed: true, used: 2 });
        expect(db.incrementQuotaIfBelow(7, "2026-07", 2)).toEqual({ allowed: false, used: 2 });
        expect(db.getQuotaUsed(7, "2026-07")).toBe(2);
        expect(db.getQuotaUsed(7, "2026-08")).toBe(0);
    });

    it("grantCredits is DB-idempotent for stripe reasons: same reason twice → one row, one balance change", () => {
        const user = db.createUser({ email: "idem@example.com", passwordHash: "h", apiToken: "ytu_idem" });
        const first = db.grantCredits(user.id, 500, "stripe:cs_dup");
        const second = db.grantCredits(user.id, 500, "stripe:cs_dup");

        expect(first).toBe(500);
        expect(second).toBe(500);
        expect(db.getUserCredits(user.id)).toBe(500);
        expect(ledgerRowCount(db, user.id, "stripe:cs_dup")).toBe(1);
    });

    it("grantCredits still allows repeated non-idempotency reasons (e.g. register-grant)", () => {
        const user = db.createUser({ email: "rep@example.com", passwordHash: "h", apiToken: "ytu_rep" });
        db.grantCredits(user.id, 100, "register-grant");
        db.grantCredits(user.id, 100, "register-grant");

        expect(db.getUserCredits(user.id)).toBe(200);
        expect(ledgerRowCount(db, user.id, "register-grant")).toBe(2);
    });

    it("getGrantsSince sums only grant-type positive deltas; hasAnyStripeGrant detects payers", () => {
        const user = db.createUser({ email: "g@example.com", passwordHash: "h", apiToken: "ytu_g" });
        db.grantCredits(user.id, 100, "register-grant");
        db.grantCredits(user.id, 500, "stripe:cs_x");
        db.spendCredits(user.id, 50, "ask");
        const since = "2000-01-01T00:00:00.000Z";

        expect(db.getGrantsSince(user.id, since)).toBe(600);
        expect(db.getUserCredits(user.id)).toBe(550);
        expect(db.getUserCredits(999_999)).toBeNull();
        expect(db.hasAnyStripeGrant(user.id)).toBe(true);
        const other = db.createUser({ email: "n@example.com", passwordHash: "h", apiToken: "ytu_n" });

        expect(db.hasAnyStripeGrant(other.id)).toBe(false);
    });
});
