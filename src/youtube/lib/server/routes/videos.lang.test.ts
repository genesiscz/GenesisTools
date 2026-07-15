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
const VIDEO = "vidlang00001" as VideoId;

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-lang-"));
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

async function call(
    method: "GET" | "POST",
    path: string,
    opts: { token?: string; body?: Record<string, unknown> } = {}
) {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, {
        method,
        headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? SafeJSON.stringify(opts.body, { strict: true }) : undefined,
    });
    const res = await handleVideosRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("summary lang plumbing", () => {
    it("GET labels a stored summary's lang ('en' default)", async () => {
        db.setVideoSummary(VIDEO, "short", "English summary");

        const res = await call("GET", `/api/v1/videos/${VIDEO}/summary?mode=short`);

        expect(res.json.lang).toBe("en");
    });

    it("an English-stored artifact requested in another lang bypasses the free reuse path and 402s at full price", async () => {
        db.setVideoSummary(VIDEO, "short", "English summary", "en");
        const user = createUser("lang@example.com", 1);

        const res = await call("POST", `/api/v1/videos/${VIDEO}/summary`, {
            token: user.token,
            body: { mode: "short", lang: "cs" },
        });

        // 1 credit can't cover the full `summary:short` price — proves the
        // lang mismatch skipped the flat REUSE_COST short-circuit and fell
        // through to the fresh-generation 402 pre-check.
        expect(res.status).toBe(402);
        expect(res.json.required).toBe(CREDIT_COSTS["summary:short"]);
    });

    it("an unknown lang code falls back to the user's saved preference, then 'en'", async () => {
        db.setVideoSummary(VIDEO, "short", "English summary");
        const user = createUser("fallback@example.com", 100);

        const res = await call("POST", `/api/v1/videos/${VIDEO}/summary`, {
            token: user.token,
            body: { mode: "short", lang: "zz" },
        });

        expect(res.json.lang).toBe("en");
    });
});
