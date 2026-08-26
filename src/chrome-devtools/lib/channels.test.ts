import { describe, expect, test } from "bun:test";
import {
    CAPTURE_CHANNELS,
    DEFAULT_CAPTURE_CHANNELS,
    parseChannels,
    RENDER_CHANNELS,
    type RenderChannel,
    renderEventLines,
} from "./channels.ts";

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
