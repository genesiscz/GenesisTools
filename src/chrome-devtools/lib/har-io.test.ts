import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedEvent } from "./channels.ts";
import { harFromMessages } from "./har/build.ts";
import type { CdpMessage } from "./har/types.ts";
import { buildHarFromBuffer, countDroppedFailures, parseDuration, sanitizeHar, stitchBodies } from "./har-io.ts";
import { segmentName } from "./segments.ts";

describe("parseDuration", () => {
    test("supports 90s / 30m / 2h and bare minutes; rejects garbage", () => {
        expect(parseDuration("90s")).toBe(90_000);
        expect(parseDuration("30m")).toBe(1_800_000);
        expect(parseDuration("2h")).toBe(7_200_000);
        expect(parseDuration("15")).toBe(900_000);
        expect(parseDuration("1.5h")).toBe(5_400_000);
        expect(parseDuration("soon")).toBeNull();
        expect(parseDuration("-5m")).toBeNull();
    });
});

describe("countDroppedFailures", () => {
    test("counts only failures HAR cannot represent (aborts stay)", () => {
        expect(
            countDroppedFailures([
                { method: "Network.loadingFailed", params: { errorText: "net::ERR_NAME_NOT_RESOLVED" } },
                { method: "Network.loadingFailed", params: { errorText: "net::ERR_ABORTED" } },
                { method: "Network.loadingFinished", params: {} },
            ])
        ).toBe(1);
    });
});

describe("stitchBodies", () => {
    test("attaches a Genesis.responseBody capture onto its session's responseReceived", () => {
        const events: RecordedEvent[] = [
            {
                method: "Network.responseReceived",
                params: { requestId: "r1", response: { url: "https://app.example.com/api" } },
                sessionId: "S1",
                t: 1,
            },
            {
                method: "Network.responseReceived",
                params: { requestId: "r1", response: { url: "https://idp.example.com/api" } },
                sessionId: "S2",
                t: 2,
            },
            {
                method: "Genesis.responseBody",
                params: { requestId: "r1", url: "https://app.example.com/api", body: '{"ok":true}' },
                sessionId: "S1",
                t: 3,
            },
        ];

        expect(stitchBodies(events)).toBe(1);
        expect((events[0].params.response as { body?: string }).body).toBe('{"ok":true}');
        expect((events[1].params.response as { body?: string }).body).toBeUndefined();
    });
});

describe("sanitizeHar", () => {
    test("redacts sensitive headers, cookie values and credential POST params; leaves the rest", () => {
        const messages: CdpMessage[] = [
            { method: "Page.frameStartedLoading", params: { frameId: "F1" } },
            {
                method: "Network.requestWillBeSent",
                params: {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1,
                    wallTime: 1700000000,
                    type: "Document",
                    initiator: { type: "other" },
                    request: {
                        method: "POST",
                        url: "https://idp.example.com/login?code=oauth-secret&state=keepme",
                        headers: { Cookie: "sid=hunter2", Accept: "text/html", "Content-Type": "text/plain" },
                        postData: "user=alice&password=hunter2&stay=1",
                    },
                },
            },
            {
                method: "Network.responseReceived",
                params: {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1.2,
                    response: {
                        url: "https://idp.example.com/login",
                        protocol: "http/1.1",
                        status: 200,
                        statusText: "OK",
                        mimeType: "text/html",
                        headers: { "Set-Cookie": "auth=tok; HttpOnly", "content-type": "text/html" },
                        encodedDataLength: 100,
                        connectionId: 1,
                    },
                },
            },
            { method: "Network.loadingFinished", params: { requestId: "r1", timestamp: 1.4, encodedDataLength: 100 } },
        ];

        const raw = harFromMessages(messages);
        const clean = sanitizeHar(raw);
        const entry = clean.log.entries[0];
        expect(entry.request.headers.find((h) => h.name === "Cookie")?.value).toBe("[REDACTED]");
        expect(entry.request.headers.find((h) => h.name === "Accept")?.value).toBe("text/html");
        expect(entry.response?.headers.find((h) => h.name === "Set-Cookie")?.value).toBe("[REDACTED]");
        expect(entry.request.postData?.text).toContain("password=[REDACTED]");
        expect(entry.request.postData?.text).toContain("user=alice");
        // OAuth ?code= must not survive --sanitize in the URL or queryString
        expect(entry.request.url).toContain("code=[REDACTED]");
        expect(entry.request.url).toContain("state=keepme");
        expect(entry.request.queryString?.find((q) => q.name === "code")?.value).toBe("[REDACTED]");
        expect(entry.request.queryString?.find((q) => q.name === "state")?.value).toBe("keepme");
        // the original is untouched
        expect(raw.log.entries[0].request.headers.find((h) => h.name === "Cookie")?.value).toBe("sid=hunter2");
        expect(raw.log.entries[0].request.url).toContain("code=oauth-secret");
    });
});

describe("buildHarFromBuffer", () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("reads segments, honors sinceMs and match, and reports dropped failures", () => {
        const root = mkdtempSync(join(tmpdir(), "cdp-har-io-"));
        dirs.push(root);
        const port = 59991;
        const dir = join(root, String(port));
        mkdirSync(dir, { recursive: true });

        const mk = (t: number, method: string, params: Record<string, unknown>): string =>
            // biome-ignore lint/style/noRestrictedGlobals: strict JSON fixture line
            JSON.stringify({ method, params, sessionId: "S1", t });

        writeFileSync(
            join(dir, segmentName(1_000)),
            [
                mk(1_000, "Page.frameStartedLoading", { frameId: "F1" }),
                mk(1_001, "Network.requestWillBeSent", {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1,
                    wallTime: 1700000000,
                    type: "Document",
                    initiator: { type: "other" },
                    request: { method: "GET", url: "https://app.example.com/", headers: {} },
                }),
                mk(1_002, "Network.responseReceived", {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1.2,
                    response: {
                        url: "https://app.example.com/",
                        protocol: "h2",
                        status: 200,
                        statusText: "",
                        mimeType: "text/html",
                        headers: {},
                        encodedDataLength: 50,
                        connectionId: 1,
                    },
                }),
                mk(1_003, "Network.loadingFinished", { requestId: "r1", timestamp: 1.4, encodedDataLength: 50 }),
                mk(1_004, "Network.loadingFailed", { requestId: "rX", timestamp: 2, errorText: "net::ERR_FAILED" }),
            ].join("\n")
        );

        const all = buildHarFromBuffer({ port, dir });
        expect(all.har.log.entries).toHaveLength(1);
        expect(all.har.log.entries[0].request.url).toBe("https://app.example.com/");
        expect(all.har.log.pages).toHaveLength(1);
        expect(all.droppedFailed).toBe(1);
        expect(all.eventCount).toBe(5);

        const since = buildHarFromBuffer({ port, dir, sinceMs: 5_000 });
        expect(since.har.log.entries).toHaveLength(0);
        // coverage always describes the WHOLE buffer, so an empty window is diagnosable
        expect(since.coverage).toEqual({ totalEvents: 5, oldestT: 1_000, newestT: 1_004 });

        const miss = buildHarFromBuffer({ port, dir, match: "nomatch.example.com" });
        expect(miss.har.log.entries).toHaveLength(0);
    });

    test("a --last window that starts AFTER the navigation still emits entries (pre-window page anchors)", () => {
        // Field failure: har --last 40s returned 0 entries for a window full
        // of traffic, because the Page.* anchor predated the window and the
        // builder drops page-less entries.
        const root = mkdtempSync(join(tmpdir(), "cdp-har-io-"));
        dirs.push(root);
        const port = 59992;
        const dir = join(root, String(port));
        mkdirSync(dir, { recursive: true });

        const mk = (t: number, method: string, params: Record<string, unknown>): string =>
            // biome-ignore lint/style/noRestrictedGlobals: strict JSON fixture line
            JSON.stringify({ method, params, sessionId: "S1", t });

        writeFileSync(
            join(dir, segmentName(1_000)),
            [
                mk(1_000, "Page.frameStartedLoading", { frameId: "F1" }),
                mk(9_001, "Network.requestWillBeSent", {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1,
                    wallTime: 1700000000,
                    type: "XHR",
                    initiator: { type: "other" },
                    request: { method: "POST", url: "https://idp.example.com/token", headers: {} },
                }),
                mk(9_002, "Network.responseReceived", {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1.2,
                    response: {
                        url: "https://idp.example.com/token",
                        protocol: "h2",
                        status: 200,
                        statusText: "",
                        mimeType: "application/json",
                        headers: {},
                        encodedDataLength: 50,
                        connectionId: 1,
                    },
                }),
                mk(9_003, "Network.loadingFinished", { requestId: "r1", timestamp: 1.4, encodedDataLength: 50 }),
            ].join("\n")
        );

        const windowed = buildHarFromBuffer({ port, dir, sinceMs: 5_000 });
        expect(windowed.har.log.entries).toHaveLength(1);
        expect(windowed.har.log.entries[0].request.url).toBe("https://idp.example.com/token");
    });
});
