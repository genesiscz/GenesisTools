import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleUsersRoute } from "@app/youtube/lib/server/routes/users";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-history-routes-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    db.upsertChannel({ handle: "@chan" });
    db.upsertVideo({
        id: "vid00000001",
        channelHandle: "@chan",
        title: "One",
        uploadDate: new Date().toISOString().slice(0, 10),
    });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    const user = db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });

    return { ...user, token: `ytu_${email}` };
}

async function call(method: string, path: string, token?: string, bodyObj?: unknown) {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "Content-Type": "application/json",
        },
        ...(bodyObj !== undefined ? { body: SafeJSON.stringify(bodyObj, { strict: true }) } : {}),
    });
    const res = await handleUsersRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("history + watchlist + digest routes", () => {
    it("history groups by video by default and by action on request", async () => {
        const user = createUser("h@example.com");
        db.recordVideoWatch({ userId: user.id, videoId: "vid00000001" });
        db.recordVideoLog({ kind: "summary:view", userId: user.id, videoId: "vid00000001", meta: null });

        const byVideo = await call("GET", "/api/v1/users/history", user.token);

        expect(byVideo.status).toBe(200);
        expect(byVideo.json.groupBy).toBe("video");
        expect((byVideo.json.videos as Array<{ videoId: string }>)[0].videoId).toBe("vid00000001");
        expect((byVideo.json.videosById as Record<string, unknown>)["vid00000001"]).toBeDefined();

        const byAction = await call("GET", "/api/v1/users/history?groupBy=action", user.token);

        expect(byAction.json.groupBy).toBe("action");
        expect((byAction.json.actions as Array<{ action: string }>).map((group) => group.action)).toContain("watch");
    });

    it("watchlist CRUD is user-scoped", async () => {
        const user = createUser("w@example.com");

        expect((await call("POST", "/api/v1/users/watchlist", user.token, { handle: "@chan" })).status).toBe(200);
        const list = await call("GET", "/api/v1/users/watchlist", user.token);

        expect((list.json.channels as unknown[]).length).toBe(1);
        expect((await call("DELETE", "/api/v1/users/watchlist/@chan", user.token)).status).toBe(200);
        expect(((await call("GET", "/api/v1/users/watchlist", user.token)).json.channels as unknown[]).length).toBe(0);
    });

    it("digest lists new videos from watched channels; sync enqueues attributed jobs", async () => {
        const user = createUser("d@example.com");
        await call("POST", "/api/v1/users/watchlist", user.token, { handle: "@chan" });
        const digest = await call("GET", "/api/v1/users/digest?sinceDays=3650", user.token);
        const channels = digest.json.channels as Array<{ handle: string; videos: unknown[] }>;

        expect(channels[0].handle).toBe("@chan");
        expect(channels[0].videos.length).toBe(1);

        const sync = await call("POST", "/api/v1/users/digest/sync", user.token);
        const jobIds = sync.json.enqueuedJobIds as number[];

        expect(jobIds.length).toBe(1);
        expect(db.getJob(jobIds[0])?.userId).toBe(user.id);
    });
});
