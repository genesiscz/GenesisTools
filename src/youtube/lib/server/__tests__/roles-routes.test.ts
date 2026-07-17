import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleModelsRoute } from "@app/youtube/lib/server/routes/models";
import { handleUsersRoute } from "@app/youtube/lib/server/routes/users";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "yt-roles-routes-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    await yt.config.update({ powerUsers: [{ email: "boss@example.com", type: "admin" }] });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    const user = db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });

    return { ...user, token: `ytu_${email}` };
}

async function getMe(token: string) {
    const url = new URL("http://localhost/api/v1/users/me");
    const req = new Request(url, { headers: { Authorization: `Bearer ${token}` } });
    const res = await handleUsersRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as { role?: string } };
}

describe("GET /users/me role", () => {
    it("returns admin for configured power users", async () => {
        const boss = createUser("boss@example.com");
        const res = await getMe(boss.token);

        expect(res.status).toBe(200);
        expect(res.json.role).toBe("admin");
    });

    it("returns user for everyone else", async () => {
        const pleb = createUser("pleb@example.com");
        const res = await getMe(pleb.token);

        expect(res.status).toBe(200);
        expect(res.json.role).toBe("user");
    });
});

describe("GET /models gating", () => {
    it("403s an authenticated regular user with code forbidden", async () => {
        const pleb = createUser("pleb@example.com");
        const url = new URL("http://localhost/api/v1/models");
        const req = new Request(url, { headers: { Authorization: `Bearer ${pleb.token}` } });
        const res = await handleModelsRoute(req, url, yt);

        expect(res.status).toBe(403);
        const body = (await res.json()) as { code?: string };

        expect(body.code).toBe("forbidden");
    });
});
