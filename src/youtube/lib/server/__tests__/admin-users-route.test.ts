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
    dir = mkdtempSync(join(tmpdir(), "yt-admin-users-"));
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

async function getUsers(token: string | null, query = "") {
    const url = new URL(`http://localhost/api/v1/admin/users${query}`);
    const req = new Request(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    const res = await handleAdminRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/v1/admin/users gating", () => {
    it("401 login_required for anonymous", async () => {
        mkUser("admin@example.com");
        const res = await getUsers(null);

        expect(res.status).toBe(401);
        expect(res.json.code).toBe("login_required");
    });

    it("403 forbidden for authed non-power user", async () => {
        mkUser("admin@example.com");
        mkUser("plain@example.com");
        const res = await getUsers("ytu_plain@example.com");

        expect(res.status).toBe(403);
        expect(res.json.code).toBe("forbidden");
    });

    it("200 for admin", async () => {
        mkUser("admin@example.com");
        const res = await getUsers("ytu_admin@example.com");

        expect(res.status).toBe(200);
    });
});

describe("admin users aggregates", () => {
    it("computes revenue, ai cost, net per user with role + subscription", async () => {
        mkUser("admin@example.com");
        const u = mkUser("payer@example.com");
        db.recordPayment({
            userId: u.id,
            kind: "pack",
            stripeRef: "cs_a",
            amountCents: 499,
            currency: "usd",
            credits: 500,
            status: "succeeded",
        });
        db.recordPayment({
            userId: u.id,
            kind: "subscription",
            stripeRef: "in_a",
            amountCents: 999,
            currency: "usd",
            credits: 3000,
            status: "succeeded",
        });
        // failed payment must NOT count toward revenue.
        db.recordPayment({
            userId: u.id,
            kind: "subscription",
            stripeRef: "failed:in_b",
            amountCents: 999,
            status: "failed",
        });
        db.recordAiCall({ provider: "xai", model: "grok", action: "summary", userId: u.id, costUsd: 0.1 });
        db.recordAiCall({ provider: "xai", model: "grok", action: "qa", userId: u.id, costUsd: 0.25 });
        db.upsertSubscription({ userId: u.id, planId: "sub-monthly", status: "active", allowance: 3000 });

        const res = await getUsers("ytu_admin@example.com");

        expect(res.status).toBe(200);
        expect(res.json.total).toBe(2);
        const users = res.json.users as Array<Record<string, unknown>>;
        const payer = users.find((row) => row.email === "payer@example.com");

        expect(payer?.revenueCents).toBe(1498);
        expect(payer?.aiCostUsd).toBeCloseTo(0.35, 5);
        expect(payer?.netUsd).toBeCloseTo(14.63, 5);
        expect(payer?.subscription).toEqual({ planId: "sub-monthly", status: "active" });
        expect(payer?.role).toBe("user");

        const adminRow = users.find((row) => row.email === "admin@example.com");

        expect(adminRow?.role).toBe("admin");
        expect(adminRow?.revenueCents).toBe(0);
        expect(adminRow?.aiCostUsd).toBe(0);
        expect(adminRow?.subscription).toBeNull();
    });

    it("searches by email substring and paginates", async () => {
        mkUser("admin@example.com");
        mkUser("alice@example.com");
        mkUser("bob@example.com");

        const searched = await getUsers("ytu_admin@example.com", "?q=ali");

        expect(searched.json.total).toBe(1);
        expect((searched.json.users as Array<{ email: string }>)[0].email).toBe("alice@example.com");

        const paged = await getUsers("ytu_admin@example.com", "?limit=1&offset=0");

        expect(paged.json.users).toHaveLength(1);
        expect(paged.json.total).toBe(3);
    });
});
