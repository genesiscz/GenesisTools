import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleAdminRoute } from "@app/youtube/lib/server/routes/admin";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "yt-admin-profile-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    await yt.config.update({ powerUsers: [{ email: "admin@example.com", type: "admin" }] });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function mkUser(email: string) {
    return db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });
}

async function getProfile(token: string | null, id: number | string) {
    const url = new URL(`http://localhost/api/v1/admin/users/${id}`);
    const req = new Request(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    const res = await handleAdminRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/v1/admin/users/:id", () => {
    it("403 for non-power, 404 for unknown id", async () => {
        mkUser("admin@example.com");
        const plain = mkUser("plain@example.com");

        expect((await getProfile("ytu_plain@example.com", plain.id)).status).toBe(403);
        expect((await getProfile("ytu_admin@example.com", 999_999)).status).toBe(404);
    });

    it("returns the full drill-in picture", async () => {
        mkUser("admin@example.com");
        const referrer = mkUser("referrer@example.com");
        const u = mkUser("target@example.com");

        db.grantCredits(u.id, 100, "register-grant");
        db.grantCredits(u.id, 500, "stripe:cs_x");
        db.recordPayment({
            userId: u.id,
            kind: "subscription",
            stripeRef: "in_a",
            amountCents: 999,
            currency: "usd",
            credits: 3000,
            status: "succeeded",
        });
        db.recordAiCall({ provider: "xai", model: "grok", action: "summary", userId: u.id, costUsd: 0.2 });
        db.upsertSubscription({
            userId: u.id,
            planId: "sub-monthly",
            status: "active",
            allowance: 3000,
            periodStart: new Date(Date.now() - 1000).toISOString(),
            periodEnd: new Date(Date.now() + 2_000_000_000).toISOString(),
            periodStartBalance: 600,
        });
        // u referred someone; u was also referred by `referrer`.
        db.getOrCreateReferralCode(u.id, "MYCODE22");
        const referee = mkUser("referee@example.com");
        db.createReferral({
            code: "MYCODE22",
            referrerUserId: u.id,
            refereeUserId: referee.id,
            reward: 25,
            offerFrom: "2026-01-01T00:00:00Z",
            offerTo: "2027-01-01T00:00:00Z",
        });
        db.getOrCreateReferralCode(referrer.id, "REFR3333");
        db.createReferral({
            code: "REFR3333",
            referrerUserId: referrer.id,
            refereeUserId: u.id,
            reward: 25,
            offerFrom: "2026-01-01T00:00:00Z",
            offerTo: "2027-01-01T00:00:00Z",
        });
        db.recordVideoWatch({ userId: u.id, videoId: "vid00000001" });
        db.recordVideoLog({ kind: "summary:view", userId: u.id, videoId: "vid00000001" });
        db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["summarize"], userId: u.id });

        const res = await getProfile("ytu_admin@example.com", u.id);

        expect(res.status).toBe(200);
        expect((res.json.user as { email: string }).email).toBe("target@example.com");
        expect(res.json.role).toBe("user");

        const billing = res.json.billing as { subscription: { allowanceRemaining: number } | null };

        expect(billing.subscription).not.toBeNull();

        const totals = res.json.totals as Record<string, number>;

        expect(totals.revenueCents).toBe(999);
        expect(totals.aiCostUsd).toBeCloseTo(0.2, 5);
        expect(totals.paymentsCount).toBe(1);
        expect(totals.aiCallsCount).toBe(1);

        expect((res.json.ledger as unknown[]).length).toBeGreaterThanOrEqual(2);
        expect((res.json.payments as unknown[]).length).toBe(1);

        const referral = res.json.referral as {
            code: string | null;
            referees: Array<{ email: string; reward: number }>;
            totalEarned: number;
            referredBy: { email: string } | null;
        };

        expect(referral.code).toBe("MYCODE22");
        expect(referral.referees).toHaveLength(1);
        expect(referral.referees[0].email).toBe("referee@example.com");
        expect(referral.totalEarned).toBe(25);
        expect(referral.referredBy?.email).toBe("referrer@example.com");

        const activity = res.json.activity as { watched: unknown[]; logs: unknown[] };

        expect(activity.watched).toHaveLength(1);
        expect(activity.logs).toHaveLength(1);
        expect((res.json.jobs as unknown[]).length).toBe(1);
    });
});
