import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { harFromMessages } from "./build.ts";
import type { CdpMessage } from "./types.ts";

/**
 * Parity: the TS port must reproduce upstream chrome-har v1.3.1 byte for byte
 * on sessionless input. The goldens under __fixtures__/golden/ were generated
 * ONCE by running the real upstream package (clone at
 * ../_Playgrounds/chrome-har) over its own recorded-in-Chrome perflogs —
 * regenerate with the session scratchpad's gen-goldens.ts if fixtures change.
 */

const FIXTURES = join(import.meta.dir, "__fixtures__");

const PERFLOGS = [
    "linkClickChrome.json",
    "samesite-sandbox.glitch.me.json",
    "response-blocked-cookies.json",
    "navigatedWithinDocument.json",
    "iframe-not-attached.json",
];

// biome-ignore lint/style/noRestrictedGlobals: goldens are strict JSON; SafeJSON strict-mode is the same parser
const strict = (text: string) => JSON.parse(text);

describe("chrome-har port parity (upstream goldens)", () => {
    for (const name of PERFLOGS) {
        test(`${name}: pages and entries equal upstream's output, and are not vacuous`, () => {
            const log = strict(readFileSync(join(FIXTURES, name), "utf8")) as CdpMessage[];
            const golden = strict(readFileSync(join(FIXTURES, "golden", name.replace(/\.json$/, ".har.json")), "utf8"));
            const ours = harFromMessages(log);
            // Non-vacuity per fixture: toEqual passes on two empty sets, which
            // would silently bless a golden that regenerated as empty.
            expect(ours.log.entries.length).toBeGreaterThan(0);
            expect(ours.log.pages.length).toBeGreaterThan(0);
            expect({ pages: ours.log.pages, entries: ours.log.entries }).toEqual(golden);
        });
    }
});

const TIMING = {
    requestTime: 1000.1,
    dnsStart: 1,
    dnsEnd: 5,
    connectStart: 5,
    connectEnd: 20,
    sslStart: 8,
    sslEnd: 19,
    sendStart: 21,
    sendEnd: 22,
    receiveHeadersEnd: 80,
    pushStart: 0,
};

describe("caller-attached bodies", () => {
    test("includeTextFromResponseBody inlines a body the caller set on the response", () => {
        const messages: CdpMessage[] = [
            { method: "Page.frameStartedLoading", params: { frameId: "F1" } },
            {
                method: "Network.requestWillBeSent",
                params: {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1000,
                    wallTime: 1700000000,
                    type: "Document",
                    initiator: { type: "other" },
                    request: { method: "GET", url: "https://app.example.com/", headers: {} },
                },
            },
            {
                method: "Network.responseReceived",
                params: {
                    requestId: "r1",
                    frameId: "F1",
                    timestamp: 1000.4,
                    response: {
                        url: "https://app.example.com/",
                        protocol: "h2",
                        status: 200,
                        statusText: "",
                        mimeType: "text/html",
                        headers: {},
                        encodedDataLength: 240,
                        connectionId: 12,
                        timing: TIMING,
                        body: "<html>ok</html>",
                    },
                },
            },
            {
                method: "Network.loadingFinished",
                params: { requestId: "r1", timestamp: 1000.6, encodedDataLength: 500 },
            },
        ];

        const har = harFromMessages(messages, { includeTextFromResponseBody: true });
        expect(har.log.entries).toHaveLength(1);
        expect(har.log.entries[0].response?.content.text).toBe("<html>ok</html>");
        expect(har.log.entries[0].response?.content.size).toBe("<html>ok</html>".length);
    });
});

describe("sessionId extension (not in upstream)", () => {
    test("colliding requestIds from two sessions stay separate entries on separate pages", () => {
        const mk = (sessionId: string, host: string): CdpMessage[] => [
            { method: "Page.frameStartedLoading", params: { frameId: `F-${sessionId}` }, sessionId },
            {
                method: "Network.requestWillBeSent",
                params: {
                    requestId: "r1",
                    frameId: `F-${sessionId}`,
                    timestamp: 2000,
                    wallTime: 1700000100,
                    type: "Document",
                    initiator: { type: "other" },
                    request: { method: "GET", url: `https://${host}/`, headers: {} },
                },
                sessionId,
            },
            {
                method: "Network.responseReceived",
                params: {
                    requestId: "r1",
                    frameId: `F-${sessionId}`,
                    timestamp: 2000.3,
                    response: {
                        url: `https://${host}/`,
                        protocol: "h2",
                        status: 200,
                        statusText: "",
                        mimeType: "text/html",
                        headers: {},
                        encodedDataLength: 100,
                        connectionId: 1,
                        timing: { ...TIMING, requestTime: 2000.1 },
                    },
                },
                sessionId,
            },
            {
                method: "Network.loadingFinished",
                params: { requestId: "r1", timestamp: 2000.5, encodedDataLength: 100 },
                sessionId,
            },
        ];

        const interleaved: CdpMessage[] = [];
        const a = mk("tab-a", "app.example.com");
        const b = mk("tab-b", "idp.example.com");
        for (let i = 0; i < a.length; i++) {
            interleaved.push(a[i], b[i]);
        }

        const har = harFromMessages(interleaved);
        expect(har.log.entries).toHaveLength(2);
        expect(har.log.entries.map((e) => e.request.url).sort()).toEqual([
            "https://app.example.com/",
            "https://idp.example.com/",
        ]);
        expect(har.log.pages).toHaveLength(2);
        expect(new Set(har.log.entries.map((e) => e.pageref)).size).toBe(2);
    });
});

describe("redirect hops keep their raw response headers (not in upstream)", () => {
    const sessionId = "tab-a";
    const frameId = "F1";
    const response = (url: string, status: number, headers: Record<string, string>) => ({
        url,
        protocol: "h2",
        status,
        statusText: "",
        mimeType: "text/html",
        headers,
        encodedDataLength: 100,
        connectionId: 1,
        timing: { ...TIMING, requestTime: 3000.1 },
    });
    const request = (url: string, timestamp: number, redirectResponse?: ReturnType<typeof response>) => ({
        method: "Network.requestWillBeSent",
        params: {
            requestId: "r1",
            frameId,
            timestamp,
            wallTime: 1700000200 + (timestamp - 3000),
            type: "Document",
            initiator: { type: "other" },
            request: { method: "POST", url, headers: {} },
            ...(redirectResponse ? { redirectResponse } : {}),
        },
        sessionId,
    });
    const extra = (statusCode: number, headers: Record<string, string>) => ({
        method: "Network.responseReceivedExtraInfo",
        params: { requestId: "r1", statusCode, headers, blockedCookies: [] },
        sessionId,
    });
    // redirectResponse carries no Set-Cookie; only the extra info has it, like Chrome sends it.
    const hop302 = response("https://idp.example.com/login", 302, { location: "https://app.example.com/" });
    const extra302 = extra(302, { location: "https://app.example.com/", "set-cookie": "TGC=abc; Path=/cas" });
    const extra200 = extra(200, { "content-type": "text/html" });
    const final = {
        method: "Network.responseReceived",
        params: {
            requestId: "r1",
            frameId,
            timestamp: 3000.6,
            response: response("https://app.example.com/", 200, { "content-type": "text/html" }),
        },
        sessionId,
    };
    const finished = {
        method: "Network.loadingFinished",
        params: { requestId: "r1", timestamp: 3000.7, encodedDataLength: 100 },
        sessionId,
    };
    const start = { method: "Page.frameStartedLoading", params: { frameId }, sessionId };

    const orders: Record<string, unknown[]> = {
        "extra info before the redirect": [
            start,
            request("https://idp.example.com/login", 3000),
            extra302,
            request("https://app.example.com/", 3000.4, hop302),
            extra200,
            final,
            finished,
        ],
        "extra info after the redirect": [
            start,
            request("https://idp.example.com/login", 3000),
            request("https://app.example.com/", 3000.4, hop302),
            extra302,
            final,
            extra200,
            finished,
        ],
    };

    for (const beforeRedirect of [true, false]) {
        test(`extra info skips a redirect that declares none, ${beforeRedirect ? "before" : "after"} the redirect`, () => {
            const redirect = request("https://app.example.com/", 3000.4, hop302);
            const markedRedirect = { ...redirect, params: { ...redirect.params, redirectHasExtraInfo: false } };
            const raw = extra(302, { "set-cookie": "final=1; Path=/" });
            const last = {
                ...final,
                params: { ...final.params, response: response("https://app.example.com/", 302, {}) },
            };
            const messages = [
                start,
                request("https://idp.example.com/login", 3000),
                ...(beforeRedirect ? [raw, markedRedirect] : [markedRedirect, raw]),
                last,
                finished,
            ];
            const entries = harFromMessages(messages as CdpMessage[]).log.entries;
            expect(
                entries.find((entry) => entry.request.url === "https://idp.example.com/login")?.response?.cookies
            ).toEqual([]);
            expect(
                entries
                    .find((entry) => entry.request.url === "https://app.example.com/")
                    ?.response?.cookies.map((c) => c.name)
            ).toEqual(["final"]);
        });
    }

    for (const beforeResponse of [true, false]) {
        test(`cached 200 accepts 304 extra info ${beforeResponse ? "before" : "after"} the response`, () => {
            const raw = extra(304, { "x-cache": "revalidated" });
            const messages = [
                start,
                request("https://app.example.com/", 3000),
                ...(beforeResponse ? [raw, final] : [final, raw]),
                finished,
            ];
            const entry = harFromMessages(messages as CdpMessage[]).log.entries[0];
            expect(entry.response?.status).toBe(200);
            expect(entry.response?.headers).toContainEqual({ name: "x-cache", value: "revalidated" });
        });
    }

    test("late extra info removes blocked cookies from the response", () => {
        const setCookie = "blocked=1; Path=/\nallowed=2; Path=/";
        const responseWithCookies = {
            ...final,
            params: {
                ...final.params,
                response: response("https://app.example.com/", 200, { "set-cookie": setCookie }),
            },
        };
        const raw = {
            ...extra(200, { "set-cookie": setCookie }),
            params: {
                ...extra(200, { "set-cookie": setCookie }).params,
                blockedCookies: [{ cookieLine: "blocked=1; Path=/", blockedReasons: ["SecureOnly"] }],
            },
        };
        const entry = harFromMessages([
            start,
            request("https://app.example.com/", 3000),
            responseWithCookies,
            raw,
            finished,
        ] as CdpMessage[]).log.entries[0];
        expect(entry.response?.cookies.map((cookie) => cookie.name)).toEqual(["allowed"]);
    });

    for (const [name, messages] of Object.entries(orders)) {
        test(`${name}: the 302 entry has Set-Cookie and the 200 entry does not`, () => {
            const har = harFromMessages(messages as CdpMessage[]);
            const hop = har.log.entries.find((e) => e.response?.status === 302);
            const last = har.log.entries.find((e) => e.response?.status === 200);
            expect(hop?.response?.headers.map((h) => h.name.toLowerCase())).toContain("set-cookie");
            expect(hop?.response?.cookies.map((c) => c.name)).toEqual(["TGC"]);
            expect(last?.response?.headers.map((h) => h.name.toLowerCase())).not.toContain("set-cookie");
            expect(last?.response?.cookies).toEqual([]);
        });
    }
});
