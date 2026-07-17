import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleUsersRoute } from "@app/youtube/lib/server/routes/users";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-me-billing-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

async function getMe(token: string) {
    const url = new URL("http://localhost/api/v1/users/me");
    const req = new Request(url, { headers: { Authorization: `Bearer ${token}` } });
    const res = await handleUsersRoute(req, url, yt);

    return (await res.json()) as {
        billing?: {
            subscription: { allowanceRemaining: number; planId: string } | null;
            freeQuota: { used: number; limit: number } | null;
            lowBalance: boolean;
        };
    };
}

describe("GET /users/me billing context", () => {
    it("free user, metering off: null sub, null quota, lowBalance from threshold", async () => {
        const user = db.createUser({ email: "m1@example.com", passwordHash: "h", apiToken: "ytu_m1" });
        db.grantCredits(user.id, 10, "register-grant");
        const body = await getMe("ytu_m1");

        expect(body.billing?.subscription).toBeNull();
        expect(body.billing?.freeQuota).toBeNull();
        expect(body.billing?.lowBalance).toBe(true);

        db.grantCredits(user.id, 100, "dev-topup");
        expect((await getMe("ytu_m1")).billing?.lowBalance).toBe(false);
    });

    it("metered user sees quota standing", async () => {
        await yt.config.update({ freeTier: { actionsPerMonth: 5 } });
        db.createUser({ email: "m2@example.com", passwordHash: "h", apiToken: "ytu_m2" });
        const body = await getMe("ytu_m2");

        expect(body.billing?.freeQuota).toEqual(expect.objectContaining({ used: 0, limit: 5 }));
    });

    it("subscriber sees derived allowanceRemaining", async () => {
        const user = db.createUser({ email: "m3@example.com", passwordHash: "h", apiToken: "ytu_m3" });
        db.grantCredits(user.id, 3000, "sub-allowance:in_seed");
        db.upsertSubscription({
            userId: user.id,
            planId: "sub-monthly",
            status: "active",
            allowance: 3000,
            periodStart: new Date(Date.now() - 1000).toISOString(),
            periodEnd: new Date(Date.now() + 2_000_000_000).toISOString(),
            periodStartBalance: 3000,
        });
        db.spendCredits(user.id, 500, "ask");
        const body = await getMe("ytu_m3");

        expect(body.billing?.subscription?.planId).toBe("sub-monthly");
        expect(body.billing?.subscription?.allowanceRemaining).toBe(2500);
    });
});
