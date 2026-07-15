import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { grantArtifactAccess } from "@app/youtube/lib/artifact-access";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { estimateReportCost } from "@app/youtube/lib/reports";
import { handleReportsRoute } from "@app/youtube/lib/server/routes/reports";
import { SummaryService } from "@app/youtube/lib/summarize";
import type { SummaryServiceDeps } from "@app/youtube/lib/summarize.types";
import { CREDIT_COSTS, REPORT_SYNTHESIS_COST, REUSE_COST } from "@app/youtube/lib/users.types";
import type { VideoId, VideoLongSummary } from "@app/youtube/lib/video.types";
import { Youtube } from "@app/youtube/lib/youtube";

const HANDLE = "@chan" as ChannelHandle;

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
    db.upsertChannel({ handle: HANDLE });
});

afterEach(() => {
    db.close();
});

function seedVideo(id: string, withLongSummary = false): VideoId {
    const videoId = id as VideoId;
    db.upsertVideo({ id: videoId, channelHandle: HANDLE, title: `t ${id}` });

    if (withLongSummary) {
        db.setVideoSummary(videoId, "long", makeLong(`gist of ${id}`));
    }

    return videoId;
}

function makeLong(tldr: string): VideoLongSummary {
    return { tldr, keyPoints: ["k1", "k2", "k3"], learnings: ["l1", "l2"], chapters: [], conclusion: null };
}

function createUser(email: string, credits: number) {
    const user = db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });
    db.grantCredits(user.id, credits, "dev-topup");

    return { ...user, credits, token: `ytu_${email}` };
}

describe("estimateReportCost", () => {
    it("mixes owned (0), locked (reuse), and missing (full) members plus the flat synthesis fee", () => {
        const user = createUser("a@example.com", 100);
        const owned = seedVideo("aaaaaaaaaa1", true);
        grantArtifactAccess(db, {
            userId: user.id,
            kind: "summary:long",
            videoId: owned,
            creditsSpent: CREDIT_COSTS["summary:long"],
        });
        const locked = seedVideo("aaaaaaaaaa2", true);
        const missing = seedVideo("aaaaaaaaaa3");

        const estimate = estimateReportCost(db, { userId: user.id, videoIds: [owned, locked, missing] });

        expect(estimate.perMemberCost).toEqual({
            [owned]: 0,
            [locked]: REUSE_COST,
            [missing]: CREDIT_COSTS["summary:long"],
        });
        expect(estimate.membersNeedingSummary).toBe(1);
        expect(estimate.creditCost).toBe(0 + REUSE_COST + CREDIT_COSTS["summary:long"] + REPORT_SYNTHESIS_COST);
    });
});

describe("synthesizeReport", () => {
    it("sends only covered members to the LLM and appends skipped members with their reason", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-report-"));
        const config = new YoutubeConfig({ baseDir: dir });

        try {
            const deps: SummaryServiceDeps = {
                createSummarizer: async () => {
                    throw new Error("not used");
                },
                callLLM: async () => {
                    throw new Error("not used");
                },
                callLLMStructured: async <T,>(opts: { userPrompt: string }) => {
                    expect(opts.userPrompt).toContain("gist of one");
                    expect(opts.userPrompt).not.toContain("vidb");
                    const object = {
                        overview: "Across both videos…",
                        themes: [{ title: "Theme", detail: "Detail", videoIds: ["vida"] }],
                        perVideo: [{ videoId: "vida", capsule: "capsule a", standout: "standout a" }],
                        disagreements: [],
                        recommendation: "Watch vida.",
                    };

                    return { content: "{}", object: object as T, usage: undefined };
                },
            };
            const service = new SummaryService(db, config, deps);
            const report = await service.synthesizeReport({
                members: [
                    {
                        videoId: "vida",
                        title: "Video A",
                        uploadDate: "2026-01-01",
                        summary: makeLong("gist of one"),
                        skipped: null,
                    },
                    {
                        videoId: "vidb",
                        title: "Video B",
                        uploadDate: null,
                        summary: null,
                        skipped: "no captions available",
                    },
                ],
                providerChoice: { provider: { name: "test" }, model: { id: "m" } } as never,
            });

            expect(report.overview).toBe("Across both videos…");
            expect(report.perVideo).toEqual([
                { videoId: "vida", capsule: "capsule a", standout: "standout a", skipped: null },
                { videoId: "vidb", capsule: "", standout: "", skipped: "no captions available" },
            ]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("reports routes", () => {
    async function call(
        yt: Youtube,
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
        const res = await handleReportsRoute(req, url, yt);

        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    }

    it("POST charges the quote up front, grants member access, stores the report, enqueues the job", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-report-route-"));
        const yt = new Youtube({ baseDir: dir, db });

        try {
            const user = createUser("b@example.com", 100);
            const v1 = seedVideo("bbbbbbbbbb1", true);
            const v2 = seedVideo("bbbbbbbbbb2");
            const expectedCost = REUSE_COST + CREDIT_COSTS["summary:long"] + REPORT_SYNTHESIS_COST;

            const estimate = await call(yt, "POST", "/api/v1/reports/estimate", {
                token: user.token,
                body: { videoIds: [v1, v2] },
            });

            expect(estimate.status).toBe(200);
            expect(estimate.json.creditCost).toBe(expectedCost);
            expect(estimate.json.membersNeedingSummary).toBe(1);

            const created = await call(yt, "POST", "/api/v1/reports", {
                token: user.token,
                body: { videoIds: [v1, v2], title: "My report" },
            });

            expect(created.status).toBe(200);
            expect(created.json.creditsSpent).toBe(expectedCost);
            expect(created.json.credits).toBe(100 - expectedCost);
            expect(created.json.jobId).toBeGreaterThan(0);

            const reportId = (created.json.report as { id: number }).id;
            const stored = db.getReport(reportId);

            expect(stored?.memberIds).toEqual([v1, v2]);
            expect(db.hasArtifactAccess(user.id, "summary:long", v1)).toBe(true);
            expect(db.hasArtifactAccess(user.id, "summary:long", v2)).toBe(true);

            const job = db.getJob(created.json.jobId as number);

            expect(job?.targetKind).toBe("report");
            expect(job?.stages).toEqual(["reportSynthesize"]);

            const list = await call(yt, "GET", "/api/v1/reports", { token: user.token });

            expect((list.json.reports as unknown[]).length).toBe(1);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("rejects member counts outside 2-20 and insufficient balances", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-report-route-"));
        const yt = new Youtube({ baseDir: dir, db });

        try {
            const user = createUser("c@example.com", 5);
            const v1 = seedVideo("ccccccccccc", true);

            const tooFew = await call(yt, "POST", "/api/v1/reports", {
                token: user.token,
                body: { videoIds: [v1] },
            });

            expect(tooFew.status).toBe(400);

            const v2 = seedVideo("ddddddddddd");
            const broke = await call(yt, "POST", "/api/v1/reports", {
                token: user.token,
                body: { videoIds: [v1, v2] },
            });

            expect(broke.status).toBe(402);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
