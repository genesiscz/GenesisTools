import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { grantArtifactAccess } from "@app/youtube/lib/artifact-access";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleVideosRoute } from "@app/youtube/lib/server/routes/videos";
import { CREDIT_COSTS, REUSE_COST } from "@app/youtube/lib/users.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import { Youtube } from "@app/youtube/lib/youtube";

const HANDLE = "@chan" as ChannelHandle;
const VIDEO = "vidreuse0001" as VideoId;
const SUMMARY_TEXT =
    "This stored short summary is deliberately longer than one hundred and forty characters so the locked-envelope preview truncation is observable in the test.";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-reuse-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    db.upsertChannel({ handle: HANDLE });
    db.upsertVideo({ id: VIDEO, channelHandle: HANDLE, title: "t" });
    db.setVideoSummary(VIDEO, "short", SUMMARY_TEXT);
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

describe("summary reuse routes", () => {
    it("GET returns a locked envelope (never 402) for signed-in users without access; anonymous stays open", async () => {
        const generator = createUser("a@example.com", 100);
        grantArtifactAccess(db, {
            userId: generator.id,
            kind: "summary:short",
            videoId: VIDEO,
            creditsSpent: CREDIT_COSTS["summary:short"],
        });
        const other = createUser("b@example.com", 100);

        const locked = await call("GET", `/api/v1/videos/${VIDEO}/summary?mode=short`, { token: other.token });

        expect(locked.status).toBe(200);
        expect(locked.json.locked).toBe(true);
        expect(locked.json.price).toBe(REUSE_COST);
        expect((locked.json.preview as { tldr: string }).tldr).toBe(SUMMARY_TEXT.slice(0, 140));

        // No login surface exists outside the extension — anonymous GETs keep
        // the open behavior instead of a teaser they could never unlock.
        const anonymous = await call("GET", `/api/v1/videos/${VIDEO}/summary?mode=short`);

        expect(anonymous.json.locked).toBeUndefined();
        expect(anonymous.json.summary).toBe(SUMMARY_TEXT);

        const owner = await call("GET", `/api/v1/videos/${VIDEO}/summary?mode=short`, { token: generator.token });

        expect(owner.json.locked).toBeUndefined();
        expect(owner.json.summary).toBe(SUMMARY_TEXT);
        expect(owner.json.cached).toBe(true);
    });

    it("POST unlocks at flat REUSE_COST with no job, then is free; GET opens up", async () => {
        const user = createUser("b@example.com", 100);

        const unlock = await call("POST", `/api/v1/videos/${VIDEO}/summary`, {
            token: user.token,
            body: { mode: "short" },
        });

        expect(unlock.status).toBe(200);
        expect(unlock.json.summary).toBe(SUMMARY_TEXT);
        expect(unlock.json.cached).toBe(true);
        expect(unlock.json.reused).toBe(true);
        expect(unlock.json.creditsSpent).toBe(REUSE_COST);
        expect(unlock.json.credits).toBe(100 - REUSE_COST);
        expect(unlock.json.jobId).toBeUndefined();

        const ledger = db
            .getDb()
            .query("SELECT reason, delta FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1")
            .get(user.id) as { reason: string; delta: number };

        expect(ledger.reason).toBe(`reuse:summary:short:${VIDEO}`);
        expect(ledger.delta).toBe(-REUSE_COST);

        const again = await call("POST", `/api/v1/videos/${VIDEO}/summary`, {
            token: user.token,
            body: { mode: "short" },
        });

        expect(again.json.creditsSpent).toBe(0);
        expect(again.json.reused).toBe(false);
        expect(again.json.credits).toBe(100 - REUSE_COST);

        const get = await call("GET", `/api/v1/videos/${VIDEO}/summary?mode=short`, { token: user.token });

        expect(get.json.locked).toBeUndefined();
        expect(get.json.summary).toBe(SUMMARY_TEXT);
    });

    it("POST unlock still 402s when the balance cannot cover the reuse price", async () => {
        const broke = createUser("c@example.com", REUSE_COST - 1);

        const res = await call("POST", `/api/v1/videos/${VIDEO}/summary`, {
            token: broke.token,
            body: { mode: "short" },
        });

        expect(res.status).toBe(402);
        expect(res.json.required).toBe(REUSE_COST);
    });

    it("missing artifact does not short-circuit — the fresh path 402s at full price", async () => {
        const user = createUser("d@example.com", 1);

        const res = await call("POST", `/api/v1/videos/${VIDEO}/summary`, {
            token: user.token,
            body: { mode: "long" },
        });

        expect(res.status).toBe(402);
        expect(res.json.required).toBe(CREDIT_COSTS["summary:long"]);
    });
});
