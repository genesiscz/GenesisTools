import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    AmbiguousTabError,
    Browser,
    type CdpCookie,
    Conn,
    cdpPortOf,
    classifyEvalError,
    closeTabCandidates,
    cookiesSummaryLine,
    evaluationExpression,
    localDebuggerUrl,
    makeMatcher,
    NoMatchingTabError,
    newTab,
    pickPageTarget,
} from "./cdp.ts";
import { findTargets } from "./dom/find.ts";
import { type DomAction, type DomSnapshot, installPageAgent } from "./dom/in-page.ts";
import { DomPage } from "./dom/page.ts";
import { createTabDriver } from "./tab-driver.ts";

test("a payload file's doc comment and trailing semicolon do not stop its function from running", () => {
    const file = "/**\n * BROWSER PAYLOAD\n */\n// helper\nasync () => {\n    return 1;\n};\n";
    expect(evaluationExpression(file)).toBe("(async () => {\n    return 1;\n})()");
    expect(evaluationExpression("() => location.href")).toBe("(() => location.href)()");
    expect(evaluationExpression("function () { return 2; }")).toBe("(function () { return 2; })()");
    expect(evaluationExpression("document.title")).toBe("document.title");
    expect(evaluationExpression("asyncValue + 1")).toBe("asyncValue + 1");
});

describe("a page-agent target named by its label", () => {
    const action = (id: string, kind: DomAction["kind"], label: string, extra: Partial<DomAction> = {}): DomAction => ({
        id,
        node: Number(id.slice(1)),
        kind,
        role: kind === "fill" ? "textbox" : "button",
        label,
        guard: id,
        ...extra,
    });
    const snapshot = (actions: DomAction[]): DomSnapshot => ({
        url: "http://127.0.0.1/",
        title: "Fixture",
        text: "",
        actions,
        omitted: 0,
        belowFold: 0,
        belowFoldLabels: [],
        secretFields: [],
        canScrollDown: false,
        canScrollUp: false,
        historyLength: 1,
        marker: "m",
    });
    const read = snapshot([
        action("n1", "click", "Save"),
        action("n2", "click", "Save as"),
        action("n3", "fill", "Search"),
        action("n4", "select", "Shipping", { role: "combobox", option: { index: 1, label: "Express" } }),
        action("n5", "click", "Buy"),
        action("n6", "click", "Buy"),
    ]);

    test("an exact label wins over a longer one that contains it", () => {
        expect(findTargets(read, { text: "save", kinds: ["click"] }).map((row) => row.id)).toEqual(["n1"]);
    });

    test("a substring matches when no label is exact", () => {
        expect(findTargets(read, { text: "as", kinds: ["click"] }).map((row) => row.id)).toEqual(["n2"]);
    });

    test("a select row is named by its option, and the kinds filter applies", () => {
        expect(findTargets(read, { text: "Express", kinds: ["click", "select"] }).map((row) => row.id)).toEqual(["n4"]);
        expect(findTargets(read, { text: "Search", kinds: ["click"] })).toEqual([]);
    });

    test("twins are all returned, so the caller refuses to guess", () => {
        expect(findTargets(read, { text: "Buy", kinds: ["click"] })).toHaveLength(2);
    });
});

test("a CDP endpoint names its port, and one on another host is refused", () => {
    expect(cdpPortOf("http://127.0.0.1:9222")).toBe(9222);
    expect(cdpPortOf("http://localhost:9333/")).toBe(9333);
    expect(() => cdpPortOf("http://10.0.0.5:9222")).toThrow("this machine");
    expect(() => cdpPortOf("http://127.0.0.1")).toThrow("names no port");
    expect(() => cdpPortOf("not a url")).toThrow();
});

test("the DOM driver accepts only a debugger socket on this machine and the requested port", () => {
    expect(localDebuggerUrl({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/A" }, 9222)).toContain(
        "127.0.0.1:9222"
    );
    expect(() => localDebuggerUrl({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/A" }, 9222)).toThrow();
    expect(() => localDebuggerUrl({ webSocketDebuggerUrl: "ws://evil.example:9222/devtools/page/A" }, 9222)).toThrow();
});

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

describe("cookiesSummaryLine", () => {
    test("an empty jar gets a plain count, never the RFC 6265 duplicate-name tip", () => {
        // Regression test: #454 — `cookies` printed the duplicate-name tip even with 0 cookies,
        // where there is nothing it could be warning about.
        expect(cookiesSummaryLine(0)).toBe("0 cookies.");
    });

    test("any cookie present gets the duplicate-name tip, since it IS possible then", () => {
        expect(cookiesSummaryLine(1)).toBe(
            "1 cookies. Duplicate name on different paths => longer path is sent FIRST (RFC 6265); servers taking the first value bind to the stale session."
        );
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

describe("DOM input dispatch and settle evidence", () => {
    const action: DomAction = { id: "n1", node: 1, kind: "click", label: "Continue", role: "button", guard: "safe" };
    const point = { ok: true, x: 20, y: 30, screen: { x: 20, y: 30 }, visible: true };
    const nativeSetTimeout = globalThis.setTimeout;
    let restore: Array<() => void> = [];

    afterEach(() => {
        for (const undo of restore.reverse()) {
            undo();
        }

        restore = [];
    });

    async function fixture(
        options: {
            hover?: "occluded" | "moved";
            settle?: "hang" | "lost" | "loaded";
            press?: "hang" | "closed";
            mutationFailure?: "selectOption" | "scroll";
        } = {}
    ) {
        const inputs: string[] = [];
        const methods: string[] = [];
        let preparations = 0;
        let listener: ((method: string, params: Record<string, unknown>) => void) | undefined;
        const websocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!;
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: class {
                onopen?: () => void;
                constructor() {
                    queueMicrotask(() => this.onopen?.());
                }
                close() {}
                addEventListener() {}
            },
        });
        const on = spyOn(Conn.prototype, "on").mockImplementation((fn) => {
            listener = fn;
        });
        const send = spyOn(Conn.prototype, "send").mockImplementation(async (method, params = {}) => {
            if (method === "Input.dispatchMouseEvent") {
                inputs.push(String(params.type));
                if (params.type === "mousePressed" && options.press === "closed") {
                    throw new Error("CDP connection closed");
                }
                if (params.type === "mousePressed" && options.press === "hang") {
                    return new Promise(() => {});
                }
            }

            if (method === "Page.getFrameTree") {
                return { frameTree: { frame: { id: "main" } } };
            }

            if (method === "Page.createIsolatedWorld") {
                return { executionContextId: 1 };
            }

            if (method !== "Runtime.evaluate") {
                return {};
            }

            if (params.expression === "document.readyState") {
                return { result: { value: "complete" } };
            }

            const agentMethod = String(params.expression).match(/globalThis\.__gtJevAgent\.(\w+)\(/)?.[1];
            methods.push(agentMethod ?? "unknown");
            if (options.mutationFailure && agentMethod === options.mutationFailure) {
                throw new Error("CDP connection closed");
            }
            let value: unknown = true;
            if (agentMethod === "prepare" || agentMethod === "focusField" || agentMethod === "selectOption") {
                preparations++;
                value =
                    preparations > 1 && options.hover === "occluded"
                        ? { ok: false, reason: "occluded" }
                        : preparations > 1 && options.hover === "moved"
                          ? { ...point, x: 50 }
                          : point;
            }

            if (agentMethod === "scroll") {
                value = 1;
            }

            if (agentMethod === "settle") {
                if (options.settle === "hang") {
                    return new Promise(() => {});
                }

                if (options.settle === "loaded") {
                    listener?.("Page.domContentEventFired", {});
                }

                if (options.settle === "lost" || options.settle === "loaded") {
                    throw new Error("Execution context was destroyed");
                }

                value = { reason: "quiet", mutations: 1, ms: 50 };
            }

            return { result: { value } };
        });
        const timer = spyOn(globalThis, "setTimeout").mockImplementation(
            Object.assign(
                (...[fn, ms, ...args]: Parameters<typeof setTimeout>) =>
                    nativeSetTimeout(fn, ms && ms > 1000 ? 5 : ms, ...args),
                nativeSetTimeout
            )
        );
        restore.push(
            () => Object.defineProperty(globalThis, "WebSocket", websocket),
            () => on.mockRestore(),
            () => send.mockRestore(),
            () => timer.mockRestore()
        );
        const page = await DomPage.attach({
            port: 9222,
            target: {
                id: "fixture",
                type: "page",
                title: "Fixture",
                url: "https://fixture.example.com",
                webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/fixture",
            },
        });
        return { page, inputs, methods, preparations: () => preparations };
    }

    test.each(["occluded", "moved"] as const)("refuses a target %s by hover before mouse-down", async (hover) => {
        const f = await fixture({ hover });
        expect(await f.page.click(action)).toEqual({
            ok: false,
            error: "target changed after hover",
            dispatched: false,
        });
        expect(f.inputs).toEqual(["mouseMoved"]);
        expect(f.preparations()).toBe(2);
    });

    test("a stable target gets one press/release and a confirmed settle", async () => {
        const f = await fixture();
        expect((await f.page.click(action)).ok).toBe(true);
        expect(f.inputs).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
        expect(f.preparations()).toBe(2);
    });

    test("a press without a reply still releases and reports uncertain delivery", async () => {
        const f = await fixture({ press: "hang" });
        expect(await f.page.click(action)).toMatchObject({ ok: false, dispatched: true });
        expect(f.inputs).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
        expect(f.methods).not.toContain("settle");
    });

    test("connection loss after sending input remains uncertain and is never replayed", async () => {
        const f = await fixture({ press: "closed" });
        expect(await f.page.click(action)).toMatchObject({ ok: false, dispatched: true });
        expect(f.inputs).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
        expect(f.methods.at(-1)).toBe("disarm");
    });

    test.each(["selectOption", "scroll"] as const)(
        "%s reports transport loss as dispatched uncertainty",
        async (mutationFailure) => {
            const f = await fixture({ mutationFailure });
            const result =
                mutationFailure === "scroll"
                    ? await f.page.scroll(1)
                    : await f.page.select({ ...action, kind: "select", option: { index: 0, label: "First" } });
            expect(result).toMatchObject({ ok: false, dispatched: true });
            expect(f.methods.filter((method) => method === mutationFailure)).toHaveLength(1);
            expect(f.methods.at(-1)).toBe("disarm");
        }
    );

    test.each(["click", "fill", "select", "scroll", "wait"] as const)(
        "%s cannot certify an unanswered settle",
        async (kind) => {
            const f = await fixture({ settle: "hang" });
            const result =
                kind === "click"
                    ? await f.page.click(action)
                    : kind === "fill"
                      ? await f.page.fill(action, "value")
                      : kind === "select"
                        ? await f.page.select({ ...action, kind: "select", option: { index: 0, label: "First" } })
                        : kind === "scroll"
                          ? await f.page.scroll(1)
                          : await f.page.wait();
            expect(result).toMatchObject({ ok: false, dispatched: kind !== "wait" });
            expect(result.ok ? "" : result.error).toContain("settle_unconfirmed");
            expect(f.methods).not.toContain("holds");
            expect(f.methods).not.toContain("selected");
        }
    );

    test("context loss without readiness is unconfirmed", async () => {
        const f = await fixture({ settle: "lost" });
        expect(await f.page.click(action)).toEqual({
            ok: false,
            error: "navigation_unconfirmed: no load event",
            dispatched: true,
        });
    });

    test("context loss followed by readiness confirms navigation", async () => {
        const f = await fixture({ settle: "loaded" });
        expect(await f.page.fill(action, "value")).toEqual({ ok: true, settled: "navigated" });
    });
});

describe("CDP transport deadlines", () => {
    type Packet = { id: number; method: string };
    const sockets: FixtureSocket[] = [];
    const socketUrl = "ws://127.0.0.1:9222/devtools/page/fixture";
    let opening = true;
    let respond: (socket: FixtureSocket, packet: Packet) => void = () => {};
    let websocket: PropertyDescriptor | undefined;
    let undoFetch: (() => void) | undefined;

    class FixtureSocket extends EventTarget {
        static OPEN = 1;
        readyState = 0;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        packets: Packet[] = [];
        closes = 0;

        constructor() {
            super();
            sockets.push(this);
            if (opening) {
                queueMicrotask(() => {
                    this.readyState = 1;
                    this.onopen?.();
                });
            }
        }

        send(raw: string) {
            const packet = SafeJSON.parse(raw, { strict: true }) as Packet;
            this.packets.push(packet);
            respond(this, packet);
        }

        reply(id: number, result: unknown) {
            this.onmessage?.({ data: SafeJSON.stringify({ id, result }, { strict: true }) });
        }

        close() {
            this.closes++;
            this.readyState = 3;
            this.dispatchEvent(new Event("close"));
        }
    }

    function fixture() {
        websocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
        Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FixtureSocket });
    }

    afterEach(() => {
        for (const socket of sockets.splice(0)) {
            socket.close();
        }

        if (websocket) {
            Object.defineProperty(globalThis, "WebSocket", websocket);
        }

        undoFetch?.();
        undoFetch = undefined;
        opening = true;
        respond = () => {};
    });

    test("an unopened socket expires and closes", async () => {
        fixture();
        opening = false;
        const conn = new Conn(socketUrl, { handshakeTimeoutMs: 5 });
        await expect(conn.send("Page.enable")).rejects.toThrow("socket did not open within");
        expect(sockets[0].closes).toBe(1);
    });

    test("command expiry forgets the request; a late reply cannot affect the next command", async () => {
        fixture();
        const conn = new Conn(socketUrl);
        await expect(conn.send("First", {}, undefined, { timeoutMs: 5 })).rejects.toThrow("First did not answer");
        sockets[0].reply(sockets[0].packets[0].id, "late");
        respond = (socket, packet) => socket.reply(packet.id, 42);
        expect(await conn.send("Second")).toBe(42);
        expect(Reflect.get(conn, "pending").size).toBe(0);
        conn.close();
    });

    test("abort and socket close reject pending commands and remove them", async () => {
        fixture();
        const conn = new Conn(socketUrl);
        const controller = new AbortController();
        const aborted = conn.send("Aborted", {}, undefined, { signal: controller.signal });
        controller.abort(new Error("cancelled"));
        await expect(aborted).rejects.toThrow("cancelled");
        const closed = conn.send("Closed");
        await Promise.resolve();
        sockets[0].close();
        await expect(closed).rejects.toThrow("connection closed");
        expect(Reflect.get(conn, "pending").size).toBe(0);
    });

    test("a send deadline includes a pending handshake and never dispatches after it expires", async () => {
        fixture();
        opening = false;
        const conn = new Conn(socketUrl);
        await expect(conn.send("First", {}, undefined, { timeoutMs: 5 })).rejects.toThrow("First did not answer");
        sockets[0].readyState = 1;
        sockets[0].onopen?.();
        await Promise.resolve();
        expect(sockets[0].packets).toHaveLength(0);
        conn.close();
    });

    test("the public evaluate budget includes enable and a failed attachment is replaceable", async () => {
        fixture();
        const fetch = spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
                async () =>
                    new Response(
                        SafeJSON.stringify(
                            [
                                {
                                    id: "fixture",
                                    type: "page",
                                    title: "Fixture",
                                    url: "https://fixture.example.com",
                                    webSocketDebuggerUrl: socketUrl,
                                },
                            ],
                            { strict: true }
                        )
                    ),
                globalThis.fetch
            )
        );
        undoFetch = () => fetch.mockRestore();
        const driver = createTabDriver(9222);
        const started = performance.now();
        await expect(driver.evaluate("fixture", "42", { deadlineMs: 15 })).rejects.toThrow("within 15 ms");
        expect(performance.now() - started).toBeLessThan(500);
        expect(sockets[0].closes).toBe(1);
        expect(sockets[0].packets.map((packet) => packet.method)).toEqual(["Page.enable"]);
        respond = (socket, packet) =>
            socket.reply(packet.id, packet.method === "Runtime.evaluate" ? { result: { value: 42 } } : {});
        expect(await driver.evaluate("fixture", "42", { deadlineMs: 100 })).toBe(42);
        expect(sockets).toHaveLength(2);
        // An old close event must not evict the replacement connection.
        sockets[0].close();
        await Promise.resolve();
        expect(await driver.evaluate("fixture", "42", { deadlineMs: 100 })).toBe(42);
        expect(sockets).toHaveLength(2);
        driver.close();
    });

    test("the public evaluate budget aborts stalled target discovery", async () => {
        fixture();
        const fetch = spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
                async (...[_input, init]: Parameters<typeof globalThis.fetch>) =>
                    new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
                    }),
                globalThis.fetch
            )
        );
        undoFetch = () => fetch.mockRestore();
        const driver = createTabDriver(9222);
        await expect(driver.evaluate("fixture", "42", { deadlineMs: 5 })).rejects.toThrow("within 5 ms");
        expect(sockets).toHaveLength(0);
        driver.close();
    });

    test("DOM attachment closes a partial socket on protocol failure", async () => {
        fixture();
        respond = (socket, packet) =>
            socket.onmessage?.({
                data: SafeJSON.stringify({ id: packet.id, error: { message: "enable failed" } }, { strict: true }),
            });
        await expect(
            DomPage.attach({
                port: 9222,
                target: {
                    id: "fixture",
                    type: "page",
                    title: "Fixture",
                    url: "https://fixture.example.com",
                    webSocketDebuggerUrl: socketUrl,
                },
            })
        ).rejects.toThrow("enable failed");
        expect(sockets[0].closes).toBe(1);
    });
});

describe("one page-agent action observer", () => {
    type Agent = {
        arm(): void;
        disarm(): void;
        settle(options: { capMs: number; quietMs: number }): Promise<{ reason: string; mutations: number }>;
    };
    function fixture(size = 0) {
        const saved = new Map<string, PropertyDescriptor | undefined>();
        let scans = 0;
        let reads = 0;
        const observers: Observer[] = [];
        class Root {
            elements: Element[] = [];
            querySelectorAll() {
                scans++;
                return this.elements;
            }
        }
        class Element extends Root {
            root: Root | null = null;
            get shadowRoot() {
                reads++;
                return this.root;
            }
        }
        class Observer {
            roots = new Set<Root>();
            queued: MutationRecord[] = [];
            constructor(readonly callback: (records: MutationRecord[]) => void) {
                observers.push(this);
            }
            observe(root: Root) {
                this.roots.add(root);
            }
            disconnect() {
                this.roots.clear();
            }
            takeRecords() {
                const records = this.queued;
                this.queued = [];
                return records;
            }
            emit(count: number, added: Element[] = []) {
                this.callback(
                    Array.from({ length: count }, () => ({ addedNodes: added }) as unknown as MutationRecord)
                );
            }
        }
        const document = new Root();
        document.elements = Array.from({ length: size }, () => new Element());
        for (const [name, value] of Object.entries({
            document,
            Element,
            MutationObserver: Observer,
            __gtJevAgent: undefined,
        })) {
            saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        }
        installPageAgent();
        const agent = Reflect.get(globalThis, "__gtJevAgent") as Agent;
        return {
            agent,
            observers,
            Element,
            Root,
            counts: () => ({ scans, reads }),
            close: () => {
                agent.disarm();
                for (const [name, descriptor] of saved) {
                    if (descriptor) {
                        Object.defineProperty(globalThis, name, descriptor);
                    } else {
                        Reflect.deleteProperty(globalThis, name);
                    }
                }
            },
        };
    }

    test("arm and settle scan a 20,000-element document once with one observer", async () => {
        const f = fixture(20_000);
        try {
            f.agent.arm();
            const result = await f.agent.settle({ capMs: 5, quietMs: 1 });
            expect(result).toMatchObject({ reason: "cap", mutations: 0 });
            expect(f.counts()).toEqual({ scans: 1, reads: 20_000 });
            expect(f.observers).toHaveLength(1);
            expect(f.observers[0].roots.size).toBe(0);
        } finally {
            f.close();
        }
    });

    test("early and late mutation batches share exact counts and wake the quiet timer", async () => {
        const f = fixture();
        try {
            f.agent.arm();
            f.observers[0].emit(2);
            f.observers[0].queued = [{ addedNodes: [] } as unknown as MutationRecord];
            const settled = f.agent.settle({ capMs: 50, quietMs: 1 });
            f.observers[0].emit(3);
            expect(await settled).toMatchObject({ reason: "quiet", mutations: 6 });
            expect(f.observers).toHaveLength(1);
        } finally {
            f.close();
        }
    });

    test("new nested shadow roots, including a root attached between arm and settle, are observed", async () => {
        const f = fixture();
        try {
            f.agent.arm();
            const host = new f.Element();
            f.observers[0].emit(1, [host]);
            const shadow = new f.Root();
            const nested = new f.Element();
            const inner = new f.Root();
            nested.root = inner;
            shadow.elements = [nested];
            host.root = shadow;
            const settled = f.agent.settle({ capMs: 50, quietMs: 1 });
            expect(f.observers[0].roots.has(shadow)).toBe(true);
            expect(f.observers[0].roots.has(inner)).toBe(true);
            const later = new f.Element();
            later.root = new f.Root();
            f.observers[0].emit(1, [later]);
            expect(f.observers[0].roots.has(later.root)).toBe(true);
            expect(await settled).toMatchObject({ reason: "quiet", mutations: 2 });
        } finally {
            f.close();
        }
    });

    test("disarm and rearm clean observer roots and complete an interrupted settle", async () => {
        const f = fixture();
        try {
            f.agent.arm();
            const settled = f.agent.settle({ capMs: 1000, quietMs: 50 });
            f.agent.arm();
            expect(await settled).toMatchObject({ reason: "cap", mutations: 0 });
            expect(f.observers[0].roots.size).toBe(0);
            f.agent.disarm();
            expect(f.observers[1].roots.size).toBe(0);
            expect(() => f.agent.settle({ capMs: 5, quietMs: 1 })).toThrow("not armed");
        } finally {
            f.close();
        }
    });
});
