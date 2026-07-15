import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleVideosRoute } from "@app/youtube/lib/server/routes/videos";
import { CREDIT_COSTS } from "@app/youtube/lib/users.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import { Youtube } from "@app/youtube/lib/youtube";

const HANDLE = "@chan" as ChannelHandle;
const VIDEO = "vidtranslate1" as VideoId;

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-translate-route-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    db.upsertChannel({ handle: HANDLE });
    db.upsertVideo({ id: VIDEO, channelHandle: HANDLE, title: "t" });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string, credits: number) {
    const user = db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });
    db.grantCredits(user.id, credits, "dev-topup");

    return { ...user, token: `ytu_${email}` };
}

async function call(path: string, opts: { token?: string; body?: Record<string, unknown> } = {}) {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, {
        method: "POST",
        headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            "Content-Type": "application/json",
        },
        body: SafeJSON.stringify(opts.body ?? {}, { strict: true }),
    });
    const res = await handleVideosRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/v1/videos/:id/transcript/translate", () => {
    it("409s when there is no transcript yet", async () => {
        const user = createUser("a@example.com", 100);

        const res = await call(`/api/v1/videos/${VIDEO}/transcript/translate`, {
            token: user.token,
            body: { lang: "cs" },
        });

        expect(res.status).toBe(409);
    });

    it("400s on an unknown lang code", async () => {
        db.saveTranscript({
            videoId: VIDEO,
            lang: "en",
            source: "captions",
            text: "hello",
            segments: [{ text: "hello", start: 0, end: 1 }],
        });
        const user = createUser("b@example.com", 100);

        const res = await call(`/api/v1/videos/${VIDEO}/transcript/translate`, {
            token: user.token,
            body: { lang: "zz" },
        });

        expect(res.status).toBe(400);
    });

    it("serves an existing translated row for free — cache checked before charging", async () => {
        db.saveTranscript({
            videoId: VIDEO,
            lang: "en",
            source: "captions",
            text: "hello",
            segments: [{ text: "hello", start: 0, end: 1 }],
        });
        db.saveTranscript({
            videoId: VIDEO,
            lang: "cs",
            source: "ai",
            text: "ahoj",
            segments: [{ text: "ahoj", start: 0, end: 1 }],
        });
        const user = createUser("c@example.com", 100);

        const res = await call(`/api/v1/videos/${VIDEO}/transcript/translate`, {
            token: user.token,
            body: { lang: "cs" },
        });

        expect(res.status).toBe(200);
        expect(res.json.creditsSpent).toBe(0);
        expect(res.json.credits).toBe(100);
        expect((res.json.transcript as { text: string }).text).toBe("ahoj");
    });

    it("402s on a cache miss when the balance can't cover CREDIT_COSTS['transcript:translate']", async () => {
        db.saveTranscript({
            videoId: VIDEO,
            lang: "en",
            source: "captions",
            text: "hello",
            segments: [{ text: "hello", start: 0, end: 1 }],
        });
        const user = createUser("d@example.com", CREDIT_COSTS["transcript:translate"] - 1);

        const res = await call(`/api/v1/videos/${VIDEO}/transcript/translate`, {
            token: user.token,
            body: { lang: "cs" },
        });

        expect(res.status).toBe(402);
        expect(res.json.required).toBe(CREDIT_COSTS["transcript:translate"]);
    });

    it("requires auth", async () => {
        const res = await call(`/api/v1/videos/${VIDEO}/transcript/translate`, { body: { lang: "cs" } });

        expect(res.status).toBe(401);
    });
});
