import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    Browser,
    type CdpCookie,
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
     */
    const fetchSpies: { mockRestore: () => void }[] = [];

    afterEach(() => {
        for (const spy of fetchSpies.splice(0)) {
            spy.mockRestore();
        }
    });

    /** Calls the real `newTab` and returns the request it made, so a regression to raw interpolation fails here. */
    const requestFor = async (target: string): Promise<{ url: string; method?: string }> => {
        const seen: { url: string; method?: string } = { url: "" };
        const spy = spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
                async (input: string | URL | Request, init?: RequestInit) => {
                    seen.url = String(input);
                    seen.method = init?.method;
                    return new Response(SafeJSON.stringify({ id: "t1", type: "page", url: target }));
                },
                { preconnect: fetch.preconnect }
            )
        );

        fetchSpies.push(spy);
        await newTab(9222, target);
        return seen;
    };

    test("a multi-parameter url survives the round trip, sent as PUT", async () => {
        const target = "https://example.com/?alpha=1&beta=2&gamma=3";
        const sent = await requestFor(target);

        expect(sent.method).toBe("PUT");
        expect(decodeURIComponent(new URL(sent.url).search.slice(1))).toBe(target);
    });

    test("the raw interpolation this replaced loses everything after the first &", () => {
        const target = "https://example.com/?alpha=1&beta=2";
        const broken = new URL(`http://127.0.0.1:9222/json/new?${target}`);
        const firstParam = broken.search.slice(1).split("&")[0];

        expect(firstParam).toBe("https://example.com/?alpha=1");
        expect(firstParam).not.toContain("beta");
    });

    test("already-encoded characters in the target are preserved", async () => {
        const target = "https://example.com/col?roles=%5BA%2CB%5D&cs=true";
        const sent = await requestFor(target);

        expect(decodeURIComponent(new URL(sent.url).search.slice(1))).toBe(target);
    });
});

describe("deleting a cookie", () => {
    const cookie = (overrides: Partial<CdpCookie> = {}): CdpCookie => ({
        name: "__Host-session",
        value: "v",
        domain: "app.example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        ...overrides,
    });

    /**
     * A jar that behaves like Chromium on the two points the delete depends on: an `expires` of
     * exactly 0 makes a SESSION cookie rather than an expired one, and a write without `secure`
     * cannot replace a Secure cookie.
     */
    const browserOver = (jar: CdpCookie[]): Browser =>
        new Browser(
            {
                send: async (method: string, params: Record<string, unknown> = {}) => {
                    if (method === "Storage.getCookies") {
                        return { cookies: jar.map((c) => ({ ...c })) };
                    }

                    for (const written of Array.isArray(params.cookies) ? params.cookies : []) {
                        const at = jar.findIndex(
                            (c) => c.name === written.name && c.domain === written.domain && c.path === written.path
                        );

                        if (at === -1 || (jar[at].secure && !written.secure)) {
                            continue;
                        }

                        if (written.expires > 0 && written.expires * 1000 < Date.now()) {
                            jar.splice(at, 1);
                        } else {
                            jar[at] = { ...jar[at], value: written.value, expires: written.expires };
                        }
                    }

                    return {};
                },
                close: () => undefined,
            },
            9222
        );

    test("removes a Secure cookie instead of turning it into a blank session cookie", async () => {
        const jar = [cookie(), cookie({ name: "keep" })];

        expect(await browserOver(jar).deleteCookie("__Host-session", "app.example.com", "/")).toBe(true);
        expect(jar.map((c) => c.name)).toEqual(["keep"]);
    });

    test("reports a cookie that does not exist rather than claiming it was deleted", async () => {
        expect(await browserOver([cookie()]).deleteCookie("nope", "app.example.com", "/")).toBe(false);
    });

    test("throws when a cookie survives the write", async () => {
        const jar = [cookie()];
        const stubborn = new Browser(
            {
                send: async (method: string) => (method === "Storage.getCookies" ? { cookies: jar } : {}),
                close: () => undefined,
            },
            9222
        );

        await expect(stubborn.deleteCookie("__Host-session", "app.example.com", "/")).rejects.toThrow(
            "still present after the delete"
        );
    });
});
