import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import type { JobStage } from "@app/youtube/lib/types";

const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const originalFetch = globalThis.fetch;

mock.module("@app/yt/config.client", () => ({
    fetchUiConfig: async () => ({
        config: { apiBaseUrl: "http://api.example.test/", firstRunComplete: true },
        where: "/tmp/server.json",
    }),
}));

describe("youtube ui apiClient", () => {
    let moduleToken = 0;

    beforeEach(() => {
        fetchCalls.length = 0;
        moduleToken++;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ input, init });
            return Response.json({
                channels: [],
                videos: [],
                jobs: [],
                added: ["@mkbhd"],
                job: { id: 1 },
                summary: "ok",
            });
        }) as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("posts channel handles to the configured API base URL", async () => {
        const { apiClient } = await import(`@app/yt/api.client?case=${moduleToken}`);

        const result = await apiClient.addChannels(["@mkbhd"]);

        expect(fetchCalls[0]?.input).toBe("http://api.example.test/api/v1/channels");
        expect(fetchCalls[0]?.init?.method).toBe("POST");
        expect(fetchCalls[0]?.init?.body).toBe(SafeJSON.stringify({ handles: ["@mkbhd"] }));
        expect(result.added).toEqual(["@mkbhd"]);
    });

    it("serializes video filters and pipeline stages", async () => {
        const { apiClient } = await import(`@app/yt/api.client?case=${moduleToken}`);
        const stages: JobStage[] = ["captions", "summarize"];

        await apiClient.listVideos({ channel: "@mkbhd", limit: 12, includeShorts: true, since: "2026-01-01" });
        await apiClient.startPipeline({ target: "abc123", targetKind: "video", stages });

        expect(fetchCalls[0]?.input).toBe(
            "http://api.example.test/api/v1/videos?channel=%40mkbhd&since=2026-01-01&limit=12&includeShorts=true"
        );
        expect(fetchCalls[1]?.input).toBe("http://api.example.test/api/v1/pipeline");
        expect(fetchCalls[1]?.init?.body).toBe(SafeJSON.stringify({ target: "abc123", targetKind: "video", stages }));
    });

    it("normalizes server summary responses by mode", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ input, init });
            return Response.json({ summary: [{ startSec: 1, endSec: 2, text: "hello" }] });
        }) as typeof fetch;
        const { apiClient } = await import(`@app/yt/api.client?case=${moduleToken}`);

        const result = await apiClient.getSummary("video-1", "timestamped");

        expect(fetchCalls[0]?.input).toBe("http://api.example.test/api/v1/videos/video-1/summary?mode=timestamped");
        expect(result.timestamped).toEqual([{ startSec: 1, endSec: 2, text: "hello" }]);
    });

    it("throws API response bodies for non-ok responses", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ input, init });
            return new Response("boom", { status: 500, statusText: "Server Error" });
        }) as typeof fetch;
        const { apiClient } = await import(`@app/yt/api.client?case=${moduleToken}`);

        await expect(apiClient.listChannels()).rejects.toThrow("500 Server Error: boom");
    });
});
