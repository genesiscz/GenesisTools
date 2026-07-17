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
    dir = mkdtempSync(join(tmpdir(), "yt-admin-ops-"));
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

async function get(path: string, token: string | null) {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    const res = await handleAdminRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("admin ops gating", () => {
    it("401 anon / 403 non-power on ai-calls", async () => {
        mkUser("admin@example.com");
        mkUser("plain@example.com");

        expect((await get("/api/v1/admin/ai-calls", null)).status).toBe(401);
        expect((await get("/api/v1/admin/ai-calls", "ytu_plain@example.com")).status).toBe(403);
        expect((await get("/api/v1/admin/ai-calls", "ytu_admin@example.com")).status).toBe(200);
    });
});

describe("GET /api/v1/admin/ai-calls", () => {
    it("lists newest-first, filters by provider/action/user, paginates", async () => {
        mkUser("admin@example.com");
        const u = mkUser("u@example.com");
        const v = mkUser("v@example.com");
        db.recordAiCall({ provider: "xai", model: "grok", action: "summary", userId: u.id, costUsd: 0.1 });
        db.recordAiCall({ provider: "openai", model: "gpt", action: "qa", userId: u.id, costUsd: 0.2 });
        db.recordAiCall({ provider: "xai", model: "grok", action: "qa", userId: v.id, costUsd: 0.3 });

        const all = await get("/api/v1/admin/ai-calls", "ytu_admin@example.com");

        expect(all.status).toBe(200);
        expect(all.json.total).toBe(3);
        expect((all.json.aiCalls as Array<{ id: number }>)[0].id).toBe(3);

        const byProvider = await get("/api/v1/admin/ai-calls?provider=xai", "ytu_admin@example.com");

        expect(byProvider.json.total).toBe(2);

        const byAction = await get("/api/v1/admin/ai-calls?action=qa", "ytu_admin@example.com");

        expect(byAction.json.total).toBe(2);

        const byUser = await get(`/api/v1/admin/ai-calls?userId=${u.id}`, "ytu_admin@example.com");

        expect(byUser.json.total).toBe(2);

        const paged = await get("/api/v1/admin/ai-calls?limit=1&offset=0", "ytu_admin@example.com");

        expect(paged.json.aiCalls).toHaveLength(1);
        expect(paged.json.total).toBe(3);
    });
});

describe("GET /api/v1/admin/webhook-logs", () => {
    it("lists and filters by outcome", async () => {
        mkUser("admin@example.com");
        db.recordWebhookLog({ stripeEventId: "evt_1", type: "checkout", payloadHash: "a", outcome: "processed" });
        db.recordWebhookLog({ stripeEventId: "evt_2", type: "checkout", payloadHash: "b", outcome: "duplicate" });
        db.recordWebhookLog({ stripeEventId: "evt_3", type: "invoice", payloadHash: "c", outcome: "error" });

        const all = await get("/api/v1/admin/webhook-logs", "ytu_admin@example.com");

        expect(all.json.total).toBe(3);
        expect((all.json.webhookLogs as Array<{ stripeEventId: string }>)[0].stripeEventId).toBe("evt_3");

        const errors = await get("/api/v1/admin/webhook-logs?outcome=error", "ytu_admin@example.com");

        expect(errors.json.total).toBe(1);
        expect((errors.json.webhookLogs as Array<{ type: string }>)[0].type).toBe("invoice");
    });
});

describe("GET /api/v1/admin/jobs", () => {
    it("lists jobs with queue stats and status filter", async () => {
        mkUser("admin@example.com");
        db.enqueueJob({ targetKind: "video", target: "vid1", stages: ["metadata"] });
        db.enqueueJob({ targetKind: "video", target: "vid2", stages: ["summarize"] });

        const res = await get("/api/v1/admin/jobs", "ytu_admin@example.com");

        expect(res.status).toBe(200);
        expect(res.json.total).toBe(2);
        expect((res.json.jobs as unknown[]).length).toBe(2);
        expect((res.json.queue as { queued: number }).queued).toBe(2);

        const pending = await get("/api/v1/admin/jobs?status=pending", "ytu_admin@example.com");

        expect(pending.json.total).toBe(2);

        const running = await get("/api/v1/admin/jobs?status=running", "ytu_admin@example.com");

        expect(running.json.total).toBe(0);
    });
});

describe("GET /api/v1/admin/revenue", () => {
    it("computes totals and zero-filled daily buckets", async () => {
        mkUser("admin@example.com");
        const u = mkUser("payer@example.com");
        db.recordPayment({ userId: u.id, kind: "pack", stripeRef: "cs_a", amountCents: 499, status: "succeeded" });
        db.recordPayment({
            userId: u.id,
            kind: "subscription",
            stripeRef: "in_a",
            amountCents: 999,
            status: "succeeded",
        });
        db.recordPayment({
            userId: u.id,
            kind: "subscription",
            stripeRef: "failed:x",
            amountCents: 999,
            status: "failed",
        });
        db.recordPayment({ userId: u.id, kind: "pack", stripeRef: "re_a", amountCents: 200, status: "refunded" });
        db.recordAiCall({ provider: "xai", model: "grok", action: "summary", userId: u.id, costUsd: 0.4 });
        db.upsertSubscription({ userId: u.id, planId: "sub-monthly", status: "active", allowance: 3000 });

        const res = await get("/api/v1/admin/revenue?days=7", "ytu_admin@example.com");

        expect(res.status).toBe(200);
        const totals = res.json.totals as Record<string, number>;

        expect(totals.revenueCents).toBe(1498);
        expect(totals.aiCostUsd).toBeCloseTo(0.4, 5);
        expect(totals.paymentsCount).toBe(2);
        expect(totals.refundsCount).toBe(1);
        expect(totals.activeSubscriptions).toBe(1);

        const daily = res.json.daily as Array<{ day: string; revenueCents: number; aiCostUsd: number }>;

        expect(daily).toHaveLength(7);
        const today = new Date().toISOString().slice(0, 10);

        expect(daily.at(-1)?.day).toBe(today);
        expect(daily.at(-1)?.revenueCents).toBe(1498);
        expect(daily.at(-1)?.aiCostUsd).toBeCloseTo(0.4, 5);
        expect(daily.reduce((sum, d) => sum + d.revenueCents, 0)).toBe(1498);
        expect(daily[0].revenueCents).toBe(0);
    });
});
