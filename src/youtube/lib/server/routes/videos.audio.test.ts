import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

let xaiAvailable = true;
const synthesizeCalls: unknown[] = [];

// Resolved BEFORE mock.module registers the override below, so this import
// still returns the real module (a self-import after registration would
// recurse into the mock).
const realProviders = await import("@app/utils/ai/providers");

mock.module("@app/utils/ai/providers", () => ({
    ...realProviders,
    getTextToSpeechProvider: (type: "xai" | "openai") => ({
        isAvailable: async () => (type === "xai" ? xaiAvailable : false),
        synthesize: async (text: string, options?: { voice?: string }) => {
            synthesizeCalls.push({ type, text, options });
            return { audio: Buffer.from("fake-mp3-bytes"), contentType: "audio/mpeg" };
        },
    }),
}));

const { YoutubeDatabase } = await import("@app/youtube/lib/db");
const { handleVideosRoute } = await import("@app/youtube/lib/server/routes/videos");
const { CREDIT_COSTS } = await import("@app/youtube/lib/users.types");
const { Youtube } = await import("@app/youtube/lib/youtube");

const HANDLE = "@chan" as import("@app/youtube/lib/channel.types").ChannelHandle;
const VIDEO = "vidaudio0001" as import("@app/youtube/lib/video.types").VideoId;

let dir: string;
let db: InstanceType<typeof YoutubeDatabase>;
let yt: InstanceType<typeof Youtube>;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-audio-route-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    db.upsertChannel({ handle: HANDLE });
    db.upsertVideo({ id: VIDEO, channelHandle: HANDLE, title: "t" });
    db.setVideoSummary(VIDEO, "long", {
        tldr: "TLDR.",
        keyPoints: ["Point"],
        learnings: [],
        chapters: [],
        conclusion: null,
    });
    synthesizeCalls.length = 0;
    xaiAvailable = true;
    env.testing.set("GENESIS_TOOLS_HOME", dir);
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    env.testing.unset("GENESIS_TOOLS_HOME");
});

function createUser(email: string, credits: number) {
    const user = db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });
    db.grantCredits(user.id, credits, "dev-topup");

    return { ...user, token: `ytu_${email}` };
}

async function call(
    method: "GET" | "POST",
    path: string,
    opts: { token?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}
) {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, {
        method,
        headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
            ...(opts.headers ?? {}),
        },
        body: opts.body ? SafeJSON.stringify(opts.body, { strict: true }) : undefined,
    });

    return handleVideosRoute(req, url, yt);
}

describe("summary audio routes", () => {
    it("POST charges CREDIT_COSTS['tts:summary'] on the first synthesis, then is free on the second", async () => {
        const user = createUser("a@example.com", 100);

        const first = await call("POST", `/api/v1/videos/${VIDEO}/summary/audio`, { token: user.token });
        const firstJson = (await first.json()) as { cached: boolean; creditsSpent: number; credits: number };

        expect(first.status).toBe(200);
        expect(firstJson.cached).toBe(false);
        expect(firstJson.creditsSpent).toBe(CREDIT_COSTS["tts:summary"]);
        expect(firstJson.credits).toBe(100 - CREDIT_COSTS["tts:summary"]);
        expect(synthesizeCalls).toHaveLength(1);

        const second = await call("POST", `/api/v1/videos/${VIDEO}/summary/audio`, { token: user.token });
        const secondJson = (await second.json()) as { cached: boolean; creditsSpent: number; credits: number };

        expect(secondJson.cached).toBe(true);
        expect(secondJson.creditsSpent).toBe(0);
        expect(secondJson.credits).toBe(100 - CREDIT_COSTS["tts:summary"]);
        expect(synthesizeCalls).toHaveLength(1);
    });

    it("POST 402s on a cache miss when the balance can't cover the charge", async () => {
        const user = createUser("b@example.com", CREDIT_COSTS["tts:summary"] - 1);

        const res = await call("POST", `/api/v1/videos/${VIDEO}/summary/audio`, { token: user.token });

        expect(res.status).toBe(402);
    });

    it("POST 409s when the video has no long summary", async () => {
        db.upsertVideo({ id: "novideo0001" as never, channelHandle: HANDLE, title: "t" });
        const user = createUser("c@example.com", 100);

        const res = await call("POST", "/api/v1/videos/novideo0001/summary/audio", { token: user.token });

        expect(res.status).toBe(409);
    });

    it("POST 503s with the exact body when no TTS provider is configured", async () => {
        xaiAvailable = false;
        const user = createUser("d@example.com", 100);

        const res = await call("POST", `/api/v1/videos/${VIDEO}/summary/audio`, { token: user.token });

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "no TTS provider configured" });
    });

    it("GET serves the synthesized audio via ?token=, Range-capable, and 404s before it exists", async () => {
        const user = createUser("e@example.com", 100);

        const before = await call("GET", `/api/v1/videos/${VIDEO}/summary/audio?token=${user.token}`);
        expect(before.status).toBe(404);

        await call("POST", `/api/v1/videos/${VIDEO}/summary/audio`, { token: user.token });

        const full = await call("GET", `/api/v1/videos/${VIDEO}/summary/audio?token=${user.token}`);
        expect(full.status).toBe(200);
        expect(full.headers.get("Accept-Ranges")).toBe("bytes");

        const ranged = await call("GET", `/api/v1/videos/${VIDEO}/summary/audio?token=${user.token}`, {
            headers: { Range: "bytes=0-3" },
        });
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("Content-Range")).toContain("bytes 0-3/");
    });

    it("GET requires a token", async () => {
        const res = await call("GET", `/api/v1/videos/${VIDEO}/summary/audio`);

        expect(res.status).toBe(401);
    });
});
