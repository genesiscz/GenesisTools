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
    dir = mkdtempSync(join(tmpdir(), "yt-users-topup-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    const user = db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });

    return { ...user, token: `ytu_${email}` };
}

async function postTopup(token: string, amount: number) {
    const url = new URL("http://localhost/api/v1/users/topup");
    const req = new Request(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: SafeJSON.stringify({ amount }, { strict: true }),
    });
    const res = await handleUsersRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/v1/users/topup", () => {
    it("is unavailable unless YOUTUBE_ALLOW_DEV_TOPUP is set", async () => {
        const user = createUser("gated@example.com");
        let res: Awaited<ReturnType<typeof postTopup>> | undefined;

        await env.testing.withOverrides({ YOUTUBE_ALLOW_DEV_TOPUP: undefined }, async () => {
            res = await postTopup(user.token, 50);
        });

        expect(res?.status).toBe(404);
        expect(db.getUserByToken(user.token)?.credits).toBe(user.credits);
    });

    it("grants credits when the dev override is enabled", async () => {
        const user = createUser("dev@example.com");
        let res: Awaited<ReturnType<typeof postTopup>> | undefined;

        await env.testing.withOverrides({ YOUTUBE_ALLOW_DEV_TOPUP: "1" }, async () => {
            res = await postTopup(user.token, 50);
        });

        expect(res?.status).toBe(200);
        expect((res?.json.user as { credits: number }).credits).toBe(user.credits + 50);
    });
});
