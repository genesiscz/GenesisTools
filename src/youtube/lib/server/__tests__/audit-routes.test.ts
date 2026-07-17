import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleVideosRoute } from "@app/youtube/lib/server/routes/videos";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-audit-routes-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    db.upsertChannel({ handle: "@chan" });
    db.upsertVideo({ id: "vid00000001", channelHandle: "@chan", title: "Video one" });
    db.saveTranscript({
        videoId: "vid00000001",
        lang: "en",
        source: "captions",
        text: "hello world",
        segments: [{ text: "hello world", start: 0, end: 2 }],
    });
    db.setVideoSummary(
        "vid00000001",
        "timestamped",
        [{ icon: "⚡", title: "t", text: "b", startSec: 0, endSec: 2 }],
        "en"
    );
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    const user = db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });

    return { ...user, token: `ytu_${email}` };
}

async function get(path: string, token?: string) {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

    return handleVideosRoute(req, url, yt);
}

describe("audit route hooks", () => {
    it("GET /videos/:id records a watcher row (user + anonymous)", async () => {
        const user = createUser("w@example.com");

        expect((await get("/api/v1/videos/vid00000001", user.token)).status).toBe(200);
        expect((await get("/api/v1/videos/vid00000001")).status).toBe(200);
        const rows = db.listVideoWatchers("vid00000001");

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.userId).sort((a, b) => Number(a) - Number(b))).toEqual(
            [null, user.id].sort((a, b) => Number(a) - Number(b))
        );
    });

    it("GET summary (timestamped, exists) logs insights:view; missing long summary logs nothing", async () => {
        // Anonymous on purpose: an authenticated user WITHOUT an artifact_access
        // row gets the locked teaser (no content, no view log) — the open
        // anonymous path is the one that serves content here.
        expect((await get("/api/v1/videos/vid00000001/summary?mode=timestamped")).status).toBe(200);
        expect((await get("/api/v1/videos/vid00000001/summary?mode=long")).status).toBe(200);
        const logs = db.listVideoLogs({ videoId: "vid00000001" });

        expect(logs.filter((log) => log.kind === "insights:view")).toHaveLength(1);
        expect(logs.filter((log) => log.kind === "insights:view")[0].userId).toBeNull();
        expect(logs.filter((log) => log.kind === "summary:view")).toHaveLength(0);
    });

    it("locked teaser (authed user without access) logs no view", async () => {
        const user = createUser("locked@example.com");
        const res = await get("/api/v1/videos/vid00000001/summary?mode=timestamped", user.token);

        expect(res.status).toBe(200);
        expect(((await res.json()) as { locked?: boolean }).locked).toBe(true);
        expect(db.listVideoLogs({ videoId: "vid00000001" })).toHaveLength(0);
    });

    it("GET transcript logs transcript:view; GET comments logs comments:view", async () => {
        expect((await get("/api/v1/videos/vid00000001/transcript")).status).toBe(200);
        expect((await get("/api/v1/videos/vid00000001/comments")).status).toBe(200);
        const logs = db.listVideoLogs({ videoId: "vid00000001" });

        expect(logs.some((log) => log.kind === "transcript:view")).toBe(true);
        expect(logs.some((log) => log.kind === "comments:view")).toBe(true);
    });

    it("does not log a transcript view on 404", async () => {
        expect((await get("/api/v1/videos/vid00000001/transcript?lang=xx&source=ai")).status).toBe(404);
        const logs = db.listVideoLogs({ videoId: "vid00000001" });

        expect(logs.filter((log) => log.kind === "transcript:view")).toHaveLength(0);
    });
});
