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
