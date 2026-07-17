import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleUsersRoute } from "@app/youtube/lib/server/routes/users";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-subscribe-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    const user = db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });

    return { ...user, token: `ytu_${email}` };
}

async function subscribe(token: string, planId: string) {
    const url = new URL("http://localhost/api/v1/users/subscribe");
    const req = new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: SafeJSON.stringify({ planId }, { strict: true }),
    });
    const res = await handleUsersRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/v1/users/subscribe", () => {
    it("400s an unknown plan before touching Stripe", async () => {
        const user = createUser("s1@example.com");
        const res = await subscribe(user.token, "sub-yearly");

        expect(res.status).toBe(400);
    });

    it("503s when billing is not configured", async () => {
        const user = createUser("s2@example.com");
        let res: Awaited<ReturnType<typeof subscribe>> | undefined;

        await env.testing.withOverrides({ STRIPE_SECRET_KEY: undefined }, async () => {
            res = await subscribe(user.token, "sub-monthly");
        });

        expect(res?.status).toBe(503);
    });

    it("409s when a subscription is already active", async () => {
        const user = createUser("s3@example.com");
        db.upsertSubscription({ userId: user.id, planId: "sub-monthly", status: "active", allowance: 3000 });
        let res: Awaited<ReturnType<typeof subscribe>> | undefined;

        await env.testing.withOverrides({ STRIPE_SECRET_KEY: "sk_test_x" }, async () => {
            res = await subscribe(user.token, "sub-monthly");
        });

        expect(res?.status).toBe(409);
    });
});
