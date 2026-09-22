import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    AmbiguousTabError,
    classifyEvalError,
    closeTabCandidates,
    makeMatcher,
    NoMatchingTabError,
    newTab,
    pickPageTarget,
} from "./cdp.ts";

describe("pickPageTarget", () => {
    test("throws when no tab URL matches instead of returning the first tab", () => {
        const pages = [
            { type: "page", url: "http://localhost:3000/" },
            { type: "page", url: "https://idp.example.com/login" },
        ];

        expect(() => pickPageTarget(pages, { url: "app.example.com" })).toThrow('no tab matching "app.example.com"');
    });

    test("returns the matching tab when the URL substring hits", () => {
        const pages = [
            { type: "page", url: "http://localhost:3000/" },
            { type: "page", url: "https://app.example.com/portal" },
        ];

        expect(pickPageTarget(pages, { url: "app.example.com" }).url).toBe("https://app.example.com/portal");
    });

    test("errors with the port when there is no page at all", () => {
        expect(() => pickPageTarget([], { port: 9222 })).toThrow("no page target on port 9222");
    });

    test("matches on the tab title too, not only the URL", () => {
        const pages = [{ type: "page", title: "Chartjs demo", url: "http://127.0.0.1:3079/x" }];

        expect(pickPageTarget(pages, { url: "Chartjs" }).url).toBe("http://127.0.0.1:3079/x");
    });

    test("a miss carries the closest tabs, so the CLI can print them", () => {
        const pages = [
            { type: "page", title: "demo", url: "http://127.0.0.1:3079/chartjs-demo" },
            { type: "page", title: "docs", url: "https://example.com/docs" },
        ];

        try {
            pickPageTarget(pages, { url: "3079/chartjs-demo-typo" });
            throw new Error("expected a NoMatchingTabError");
        } catch (err) {
            expect(err).toBeInstanceOf(NoMatchingTabError);
            expect((err as NoMatchingTabError).candidates[0].url).toBe("http://127.0.0.1:3079/chartjs-demo");
        }
    });
});

describe("makeMatcher", () => {
    test("plain patterns are substrings", () => {
        expect(makeMatcher("3079")("http://127.0.0.1:3079/x")).toBe(true);
        expect(makeMatcher("3079")("http://127.0.0.1:3080/x")).toBe(false);
    });

    test("/pattern/flags is a regex — the --match help promised this from day one", () => {
        expect(makeMatcher("/30(79|81)/")("http://127.0.0.1:3081/x")).toBe(true);
        expect(makeMatcher("/^https:/")("http://127.0.0.1:3081/x")).toBe(false);
        expect(makeMatcher("/CHARTJS/i")("http://127.0.0.1:3079/chartjs")).toBe(true);
    });

    test("a bare slash-free pattern that looks regexy stays literal", () => {
        expect(makeMatcher("a|b")("x a|b y")).toBe(true);
        expect(makeMatcher("a|b")("just a")).toBe(false);
    });
});

describe("closeTabCandidates", () => {
    test("ranks tabs sharing tokens with the failed match first", () => {
        const pages = [
            { title: "unrelated", url: "https://example.com/" },
            { title: "demo", url: "http://127.0.0.1:3079/chartjs-demo" },
        ];

        expect(closeTabCandidates(pages, "3079/chartjs-demo-typo")[0].url).toBe("http://127.0.0.1:3079/chartjs-demo");
    });

    test("with no token overlap it still shows what is open, capped", () => {
        const pages = Array.from({ length: 20 }, (_, i) => ({ title: "t", url: `https://a.example/${i}` }));

        expect(closeTabCandidates(pages, "zzzzzz")).toHaveLength(6);
    });
});

/**
 * Regression test: PR #336 review t1. The eval path treated any error whose text
 * contained "connection closed" as proof the script had navigated, and exited 0.
 * That is a websocket-level failure, not a CDP navigation signal — the browser
 * dying mid-eval produces it too, and the expression may never have run. Exit 0
 * there tells an automation caller a navigation happened when nothing did.
 */
describe("classifyEvalError", () => {
    test("the two CDP protocol errors mean the script navigated the page", () => {
        expect(classifyEvalError("Execution context was destroyed.")).toBe("navigated");
        expect(classifyEvalError("Inspected target navigated or closed")).toBe("navigated");
    });

    test("matching is case-insensitive, as Chrome's casing has changed between versions", () => {
        expect(classifyEvalError("execution CONTEXT WAS DESTROYED")).toBe("navigated");
    });

    test("a closed connection is a failure, not a navigation", () => {
        expect(classifyEvalError("connection closed")).toBe("failed");
        expect(classifyEvalError("WebSocket connection closed before the response arrived")).toBe("failed");
    });

    test("anything else is a failure", () => {
        expect(classifyEvalError("SyntaxError: Unexpected token")).toBe("failed");
        expect(classifyEvalError("")).toBe("failed");
    });
});

describe("newTab url encoding", () => {
    /**
     * `/json/new` takes its target as the endpoint's OWN query string, so an unencoded `&` in the
     * target is read as a second parameter of /json/new and everything after it is dropped.
     * Observed 2026-09-20: `?customerService=true&simulatedRoles=[...]` opened a tab on
     * `?customerService=true`, which read as the app stripping the query rather than as our bug.
     *
     * These drive the real `newTab` through a stubbed `fetch`. An earlier version defined its own
     * `endpointFor` helper and asserted on that, so it tested the test's arithmetic: `newTab`
     * could have dropped the encoding entirely and every case would still have passed.
     */
    const sent: Array<{ url: string; method?: string }> = [];
    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            sent.push({ url: String(input), method: init?.method });

            return Promise.resolve(new Response(SafeJSON.stringify({ id: "T1", url: "about:blank" }), { status: 200 }));
        }) as typeof globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        sent.length = 0;
    });

    test("a multi-parameter url survives the round trip", async () => {
        const target = "https://example.com/?alpha=1&beta=2&gamma=3";

        await newTab(9222, target);

        expect(decodeURIComponent(new URL(sent[0]!.url).search.slice(1))).toBe(target);
    });

    test("everything after the first & would be lost without the encoding", async () => {
        const target = "https://example.com/?alpha=1&beta=2";

        await newTab(9222, target);

        const query = new URL(sent[0]!.url).search.slice(1);

        // One parameter, not two: the whole target is the value, so nothing was split off.
        expect(query.split("&")).toHaveLength(1);
        expect(decodeURIComponent(query)).toContain("beta=2");
    });

    test("already-encoded characters in the target are preserved", async () => {
        const target = "https://example.com/col?roles=%5BA%2CB%5D&cs=true";

        await newTab(9222, target);

        expect(decodeURIComponent(new URL(sent[0]!.url).search.slice(1))).toBe(target);
    });

    test("uses PUT, because Chromium 111 and later reject the GET form", async () => {
        await newTab(9222, "https://example.com/");

        expect(sent[0]!.method).toBe("PUT");
    });

    test("a refusal is reported rather than returned as a tab", async () => {
        globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
            Promise.resolve(new Response("no", { status: 500 }))) as typeof globalThis.fetch;

        await expect(newTab(9222, "https://example.com/")).rejects.toThrow("could not open a tab on 9222");
    });
});

describe("pickPageTarget ranks url above title", () => {
    /** An open inspector for a page carries `DevTools - <host><path>` as its TITLE. */
    const inspectorFor = (url: string) => ({
        type: "page",
        url: "devtools://devtools/bundled/devtools_app.html",
        title: `DevTools - ${url.replace(/^https?:\/\//, "")}`,
    });

    test("the page wins over the inspector whose title ends the same way", () => {
        const app = { type: "page", url: "https://app.example.com/auth-callback?cs=true", title: "App" };
        const picked = pickPageTarget([inspectorFor(app.url), app], { url: "/auth-callback\\?cs=true$/" });

        // Matching on title alone would return the DevTools frontend, and `eval` would then
        // run against the Network panel's own DOM instead of the app.
        expect(picked.url).toBe(app.url);
    });

    test("a title match is still used when no url matches at all", () => {
        const only = { type: "page", url: "https://example.com/x", title: "Checkout page" };

        expect(pickPageTarget([only], { url: "Checkout" }).url).toBe(only.url);
    });

    test("two url matches are ambiguous rather than silently first-wins", () => {
        const pages = [
            { type: "page", url: "https://app.example.com/col?cs=true", title: "a" },
            { type: "page", url: "https://app.example.com/col?cs=true&simulatedPartner=1", title: "b" },
        ];

        expect(() => pickPageTarget(pages, { url: "col?cs=true" })).toThrow(AmbiguousTabError);
    });

    test("an anchored regex tells those two apart", () => {
        const pages = [
            { type: "page", url: "https://app.example.com/col?cs=true", title: "a" },
            { type: "page", url: "https://app.example.com/col?cs=true&simulatedPartner=1", title: "b" },
        ];

        expect(pickPageTarget(pages, { url: "/col\\?cs=true$/" }).title).toBe("a");
    });

    test("a non-page target is never considered", () => {
        const list = [
            { type: "service_worker", url: "https://app.example.com/sw.js", title: "sw" },
            { type: "page", url: "https://app.example.com/", title: "app" },
        ];

        expect(pickPageTarget(list, { url: "app.example.com" }).type).toBe("page");
    });
});
