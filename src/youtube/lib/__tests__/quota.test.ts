import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { enforceFreeQuota } from "@app/youtube/lib/quota";
import { handleVideosRoute } from "@app/youtube/lib/server/routes/videos";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-quota-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    return db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });
}

describe("enforceFreeQuota", () => {
    it("is a no-op while metering is disabled (default config)", async () => {
        const user = createUser("q0@example.com");

        expect(await enforceFreeQuota(yt, user)).toBeNull();
        expect(await enforceFreeQuota(yt, user)).toBeNull();
    });

    it("allows N actions then returns a typed 402", async () => {
        await yt.config.update({ freeTier: { actionsPerMonth: 2 } });
        const user = createUser("q1@example.com");

        expect(await enforceFreeQuota(yt, user)).toBeNull();
        expect(await enforceFreeQuota(yt, user)).toBeNull();
        const denied = await enforceFreeQuota(yt, user);

        expect(denied?.status).toBe(402);
        const body = (await denied?.json()) as { code?: string };

        expect(body.code).toBe("quota_exhausted");
    });

    it("exempts active subscribers and stripe payers", async () => {
        await yt.config.update({ freeTier: { actionsPerMonth: 0 } });
        const subscriber = createUser("q2@example.com");
        db.upsertSubscription({ userId: subscriber.id, planId: "sub-monthly", status: "active", allowance: 3000 });

        expect(await enforceFreeQuota(yt, subscriber)).toBeNull();

        const payer = createUser("q3@example.com");
        db.grantCredits(payer.id, 500, "stripe:cs_seed");

        expect(await enforceFreeQuota(yt, payer)).toBeNull();

        const pleb = createUser("q4@example.com");

        expect((await enforceFreeQuota(yt, pleb))?.status).toBe(402);
    });

    it("does not exempt canceled subscriptions", async () => {
        await yt.config.update({ freeTier: { actionsPerMonth: 0 } });
        const churned = createUser("q5@example.com");
        db.upsertSubscription({ userId: churned.id, planId: "sub-monthly", status: "canceled", allowance: 3000 });

        expect((await enforceFreeQuota(yt, churned))?.status).toBe(402);
    });
});

describe("quota gate wiring (translate route)", () => {
    it("402s at the charge point before any provider work", async () => {
        await yt.config.update({ freeTier: { actionsPerMonth: 0 } });
        const user = db.createUser({ email: "q6@example.com", passwordHash: "h", apiToken: "ytu_q6" });
        db.grantCredits(user.id, 100, "register-grant");
        db.upsertChannel({ handle: "@chan" });
        db.upsertVideo({ id: "vid00000001", channelHandle: "@chan", title: "t" });
        db.saveTranscript({
            videoId: "vid00000001",
            lang: "en",
            source: "captions",
            text: "hi",
            segments: [{ text: "hi", start: 0, end: 1 }],
        });

        const url = new URL("http://localhost/api/v1/videos/vid00000001/transcript/translate");
        const req = new Request(url, {
            method: "POST",
            headers: { Authorization: "Bearer ytu_q6", "Content-Type": "application/json" },
            body: '{"lang":"cs"}',
        });
        const res = await handleVideosRoute(req, url, yt);

        expect(res.status).toBe(402);
        expect(((await res.json()) as { code?: string }).code).toBe("quota_exhausted");
        // The gate fired before the credit reserve — balance untouched.
        expect(db.getUserCredits(user.id)).toBe(100);
    });
});
