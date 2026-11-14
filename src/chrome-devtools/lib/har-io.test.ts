import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { RecordedEvent } from "./channels.ts";
import { harFromMessages } from "./har/build.ts";
import type { CdpMessage } from "./har/types.ts";
import {
    buildHarFromBuffer,
    countDroppedFailures,
    countLocalNetworkBlocks,
    parseDuration,
    sanitizeHar,
    stitchBodies,
} from "./har-io.ts";
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

describe("countLocalNetworkBlocks", () => {
    test("counts only failures with a Local Network Access CORS error", () => {
        expect(
            countLocalNetworkBlocks([
                {
                    method: "Network.loadingFailed",
                    params: {
                        errorText: "net::ERR_FAILED",
                        corsErrorStatus: { corsError: "LocalNetworkAccessPermissionDenied" },
                    },
                },
                { method: "Network.loadingFailed", params: { errorText: "net::ERR_CONNECTION_REFUSED" } },
                { method: "Network.requestWillBeSent", params: {} },
            ])
        ).toBe(1);
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
        // The page is titled with the same URL, so the code must leave the title too, and nowhere may it remain.
        expect(clean.log.pages[0]?.title).toContain("code=[REDACTED]");
        expect(SafeJSON.stringify(clean)).not.toContain("oauth-secret");
        // the original is untouched
        expect(raw.log.entries[0].request.headers.find((h) => h.name === "Cookie")?.value).toBe("sid=hunter2");
        expect(raw.log.entries[0].request.url).toContain("code=oauth-secret");
    });
});

describe("sanitizeHar encoded POST credentials", () => {
    test("redacts encoded form names in both stored copies without rewriting ordinary pairs", () => {
        const raw = harFromMessages([
            { method: "Page.frameStartedLoading", params: { frameId: "F1" } },
            {
                method: "Network.requestWillBeSent",
                params: {
                    requestId: "form",
                    frameId: "F1",
                    type: "Document",
                    initiator: { type: "other" },
                    timestamp: 1,
                    wallTime: 1700000000,
                    request: { method: "POST", url: "https://idp.example.com/login", headers: {} },
                },
            },
            {
                method: "Network.responseReceived",
                params: {
                    requestId: "form",
                    frameId: "F1",
                    timestamp: 1.2,
                    response: {
                        url: "https://idp.example.com/login",
                        protocol: "http/1.1",
                        status: 200,
                        statusText: "OK",
                        mimeType: "text/html",
                        headers: {},
                        encodedDataLength: 10,
                        connectionId: 1,
                    },
                },
            },
            { method: "Network.loadingFinished", params: { requestId: "form", timestamp: 1.4, encodedDataLength: 10 } },
        ]);
        const text =
            "co%64e=code-secret&access%5Ftoken=access-secret&CLIENT_SECRET=client-secret&state=a%2Bb&xcode=keep&bad%=ordinary";
        raw.log.entries[0].request.postData = {
            mimeType: "application/x-www-form-urlencoded",
            text,
            params: [
                { name: "co%64e", value: "param-secret" },
                { name: "id%5Ftoken%5Fhint", value: "hint-secret" },
                { name: "state", value: "a+b" },
            ],
        };

        const clean = sanitizeHar(raw);
        const serialized = SafeJSON.stringify(clean);
        for (const secret of ["code-secret", "access-secret", "client-secret", "param-secret", "hint-secret"]) {
            expect(serialized).not.toContain(secret);
        }

        expect(clean.log.entries[0].request.postData?.text).toBe(
            "co%64e=[REDACTED]&access%5Ftoken=[REDACTED]&CLIENT_SECRET=[REDACTED]&state=a%2Bb&xcode=keep&bad%=ordinary"
        );
        expect(clean.log.entries[0].request.postData?.params?.at(-1)).toEqual({ name: "state", value: "a+b" });
        expect(raw.log.entries[0].request.postData?.text).toBe(text);

        // A text/plain form puts one pair on each line; a multipart form puts each value in its own part.
        raw.log.entries[0].request.postData = { mimeType: "text/plain", text: "user=alice\r\npassword=plain-secret\n" };
        const plain = SafeJSON.stringify(sanitizeHar(raw));
        expect(plain).not.toContain("plain-secret");
        expect(plain).toContain("user=alice");

        // In a text/plain value `&` is a literal character, so the whole line after `password=` is the password.
        raw.log.entries[0].request.postData = {
            mimeType: "text/plain",
            text: "password=first&remaining-secret\r\nuser=alice\r\nnote=a&code=amp-secret\r\n",
        };
        const ampersand = sanitizeHar(raw).log.entries[0].request.postData?.text ?? "";
        expect(ampersand).not.toContain("remaining-secret");
        expect(ampersand).not.toContain("amp-secret");
        expect(ampersand).toContain("password=[REDACTED]\r\nuser=alice\r\n");

        const multipart = [
            "--fixture-boundary",
            'Content-Disposition: form-data; name="user"',
            "",
            "alice",
            "--fixture-boundary",
            'Content-Disposition: form-data; name="client_secret"',
            "Content-Type: text/plain",
            "",
            "part-secret",
            "--fixture-boundary--",
            "",
        ].join("\r\n");
        raw.log.entries[0].request.postData = {
            mimeType: "multipart/form-data; boundary=fixture-boundary",
            text: multipart,
        };
        const parts = sanitizeHar(raw).log.entries[0].request.postData?.text ?? "";
        expect(parts).not.toContain("part-secret");
        expect(parts).toContain("alice");

        const dashed = [
            "--fixture-boundary",
            'Content-Disposition: form-data; name="password"',
            "",
            "first",
            "--ordinary-value-line",
            "remaining-secret",
            "--fixture-boundary--",
            "",
        ].join("\r\n");
        raw.log.entries[0].request.postData = {
            mimeType: "multipart/form-data; boundary=fixture-boundary",
            text: dashed,
        };
        const whole = sanitizeHar(raw).log.entries[0].request.postData?.text ?? "";
        expect(whole).not.toContain("first");
        expect(whole).not.toContain("remaining-secret");
    });
});

describe("sanitizeHar on an OAuth redirect", () => {
    test("redacts an encoded code name, an id_token_hint, and the code in Location and Referer", () => {
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
                        method: "GET",
                        url: "https://idp.example.com/authorize?id_token_hint=hint-secret&co%64e=encoded-secret&state=keepme",
                        headers: { Referer: "https://app.example.com/start?code=referer-secret" },
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
                        url: "https://idp.example.com/authorize",
                        protocol: "http/1.1",
                        status: 302,
                        statusText: "Found",
                        mimeType: "text/html",
                        headers: { Location: "https://app.example.com/callback?code=location-secret&state=keepme" },
                        encodedDataLength: 100,
                        connectionId: 1,
                    },
                },
            },
            { method: "Network.loadingFinished", params: { requestId: "r1", timestamp: 1.4, encodedDataLength: 100 } },
        ];

        const text = SafeJSON.stringify(sanitizeHar(harFromMessages(messages)));

        // The page title is the request URL too, so the first two cover it as well.
        for (const secret of ["hint-secret", "encoded-secret", "referer-secret", "location-secret"]) {
            expect(text).not.toContain(secret);
        }
        expect(text).toContain("co%64e=[REDACTED]");
        expect(text).toContain("state=keepme");
    });
});

describe("sanitizeHar custom credential headers", () => {
    // 2026-11-02: a HAR written with --sanitize still carried a live `authToken` request header.
    test("masks authToken and other credential headers by name, case-insensitive; keeps ordinary ones", () => {
        const messages: CdpMessage[] = [
            { method: "Page.frameStartedLoading", params: { frameId: "F1" } },
            {
                method: "Network.requestWillBeSent",
                params: {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1,
                    wallTime: 1700000000,
                    type: "XHR",
                    initiator: { type: "other" },
                    request: {
                        method: "GET",
                        url: "https://timesheets.example.com/ppm/rest/v1/timesheets",
                        headers: {
                            authToken: "12345678__00000000-0000-0000-0000-000000000000",
                            "X-Auth-Token": "fake-auth-token-value",
                            "x-api-next-string": "dHJ1ZQ==",
                            Accept: "application/json",
                        },
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
                        url: "https://timesheets.example.com/ppm/rest/v1/timesheets",
                        protocol: "http/1.1",
                        status: 200,
                        statusText: "OK",
                        mimeType: "application/json",
                        headers: { "content-type": "application/json" },
                        encodedDataLength: 10,
                        connectionId: 1,
                    },
                },
            },
            { method: "Network.loadingFinished", params: { requestId: "r1", timestamp: 1.3, encodedDataLength: 10 } },
        ];

        const clean = sanitizeHar(harFromMessages(messages));
        const headers = clean.log.entries[0].request.headers;
        const value = (name: string) => headers.find((h) => h.name === name)?.value;
        expect(value("authToken")).toBe("[REDACTED]");
        expect(value("X-Auth-Token")).toBe("[REDACTED]");
        expect(value("x-api-next-string")).toBe("dHJ1ZQ==");
        expect(value("Accept")).toBe("application/json");
        expect(SafeJSON.stringify(clean)).not.toContain("12345678__00000000-0000-0000-0000-000000000000");
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
