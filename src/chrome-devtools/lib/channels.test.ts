import { describe, expect, test } from "bun:test";
import {
    CAPTURE_CHANNELS,
    DEFAULT_CAPTURE_CHANNELS,
    parseChannels,
    RENDER_CHANNELS,
    type RecordedEvent,
    type RenderChannel,
    renderEventLines,
} from "./channels.ts";
import { type LoopAlert, LoopDetector, loopLine, navigationKey } from "./loops.ts";

const all = (channels: RenderChannel[]) => new Set(channels);
const yes = () => true;

describe("parseChannels", () => {
    test("empty input keeps the defaults", () => {
        expect(parseChannels("", CAPTURE_CHANNELS, DEFAULT_CAPTURE_CHANNELS).channels).toEqual(
            DEFAULT_CAPTURE_CHANNELS
        );
    });

    test("+list is additive over the defaults; a plain list replaces them", () => {
        const additive = parseChannels("+ws,body", CAPTURE_CHANNELS, DEFAULT_CAPTURE_CHANNELS);
        expect(additive.channels).toEqual([...DEFAULT_CAPTURE_CHANNELS, "ws", "body"]);
        const replace = parseChannels("net", CAPTURE_CHANNELS, DEFAULT_CAPTURE_CHANNELS);
        expect(replace.channels).toEqual(["net"]);
    });

    test("invalid names are reported, never silently dropped", () => {
        const parsed = parseChannels("nav,bogus", RENDER_CHANNELS, ["nav"]);
        expect(parsed.invalid).toEqual(["bogus"]);
        expect(parsed.channels).toEqual(["nav"]);
    });
});

describe("renderEventLines", () => {
    test("redirect events carry status, target and set-cookie", () => {
        const lines = renderEventLines(
            {
                method: "Network.requestWillBeSent",
                params: {
                    requestId: "r1",
                    request: { url: "https://idp.example.com/next", method: "GET" },
                    redirectResponse: {
                        status: 302,
                        url: "https://idp.example.com/login",
                        headers: { Location: "https://idp.example.com/next", "set-cookie": "seen=1" },
                    },
                },
                t: 0,
            },
            all(["redirect"]),
            yes
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("REDIRECT");
        expect(lines[0]).toContain("302");
        expect(lines[0]).toContain("-> https://idp.example.com/next");
        expect(lines[0]).toContain("set-cookie: seen=1");
    });

    test("console errors route to the error channel, plain logs to console", () => {
        const err = renderEventLines(
            { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: "boom" }] }, t: 0 },
            all(["error"]),
            yes
        );
        expect(err[0]).toContain("CERROR");

        const plain = renderEventLines(
            { method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ value: "hello" }] }, t: 0 },
            all(["error"]),
            yes
        );
        expect(plain).toEqual([]);
    });

    test("match filter applies to URLs", () => {
        const lines = renderEventLines(
            {
                method: "Network.requestWillBeSent",
                params: {
                    requestId: "r1",
                    type: "Document",
                    request: { url: "https://other.example.com/", method: "GET" },
                },
                t: 0,
            },
            all(["doc"]),
            (u) => u.includes("app.example.com")
        );
        expect(lines).toEqual([]);
    });

    test("Genesis marker events always render", () => {
        const lines = renderEventLines(
            { method: "Genesis.marker", params: { kind: "capDropped", detail: "x" }, t: 0 },
            all(["nav"]),
            yes
        );
        expect(lines[0]).toContain("MARKER");
        expect(lines[0]).toContain("capDropped");
    });
});

describe("loop detection", () => {
    const nav = (url: string, t: number): RecordedEvent => ({
        method: "Page.frameNavigated",
        params: { frame: { url } },
        t,
    });
    const hop = (from: string, t: number): RecordedEvent => ({
        method: "Network.requestWillBeSent",
        params: {
            type: "Document",
            request: { url: "x", method: "GET" },
            redirectResponse: { url: from, status: 302 },
        },
        t,
    });

    test("a page is keyed by path and query NAMES, so changing code/state values still match", () => {
        expect(navigationKey("https://app.example.com/cb?state=a1&code=x#f")).toBe(
            "https://app.example.com/cb?code&state"
        );
        expect(navigationKey("https://app.example.com/cb?code=y&state=b2")).toBe(
            "https://app.example.com/cb?code&state"
        );
    });

    test("an auth loop is reported at the third visit with its cycle, and again while it continues", () => {
        const detector = new LoopDetector({ threshold: 3, windowMs: 60_000 });
        const alerts = [];
        for (let lap = 0; lap < 6; lap++) {
            const t = lap * 1000;
            alerts.push(...detector.observe(hop(`https://idp.example.com/authorize?state=${lap}`, t)));
            alerts.push(...detector.observe(nav(`https://app.example.com/cb?code=${lap}&state=${lap}`, t + 400)));
        }

        const app = alerts.filter((alert) => alert.key === "https://app.example.com/cb?code&state");
        expect(app.map((alert) => alert.count)).toEqual([3, 6]);
        expect(app[0]?.cycle).toEqual([
            "https://app.example.com/cb?code&state",
            "https://idp.example.com/authorize?state",
            "https://app.example.com/cb?code&state",
        ]);
        expect(loopLine(app[0] as LoopAlert, () => "12:00:00.000")).toContain("seen 3x in 2.0 s; cycle:");
    });

    test("visits spread wider than the window, iframes' commits and subresource redirects never count", () => {
        const detector = new LoopDetector({ threshold: 3, windowMs: 1_000 });
        const quiet = [
            nav("https://app.example.com/home", 0),
            nav("https://app.example.com/home", 5_000),
            nav("https://app.example.com/home", 10_000),
            {
                method: "Page.frameNavigated",
                params: { frame: { url: "https://app.example.com/home", parentId: "1" } },
                t: 10_100,
            },
            {
                method: "Network.requestWillBeSent",
                params: {
                    type: "XHR",
                    request: { url: "x", method: "GET" },
                    redirectResponse: { url: "https://app.example.com/home" },
                },
                t: 10_200,
            },
        ];
        expect(quiet.flatMap((event) => detector.observe(event))).toEqual([]);
    });
});

describe("Local Network Access hint", () => {
    test("a FAIL line names the LNA block and the grant command; an ordinary failure gets no hint", () => {
        const blocked = renderEventLines(
            {
                method: "Network.loadingFailed",
                params: {
                    requestId: "7.1",
                    type: "Fetch",
                    errorText: "net::ERR_FAILED",
                    corsErrorStatus: { corsError: "LocalNetworkAccessPermissionDenied" },
                },
                t: 0,
            },
            all(["error"]),
            yes
        );
        expect(blocked[0]).toContain("blocked by Local Network Access (LocalNetworkAccessPermissionDenied)");
        expect(blocked[0]).toContain("tools chrome-devtools grant --match <tab>");
        const refused = renderEventLines(
            {
                method: "Network.loadingFailed",
                params: { requestId: "7.2", type: "Fetch", errorText: "net::ERR_CONNECTION_REFUSED" },
                t: 0,
            },
            all(["error"]),
            yes
        );
        expect(refused[0]).not.toContain("Local Network Access");
    });
});
