import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { abSchedule, runAb } from "./ab.ts";
import type { CdpLike } from "./cdp-like.ts";
import { callInPage, InPageError, inPageExpression } from "./evaluate.ts";
import { clearStorageKeys } from "./in-page/clear-storage.ts";
import { idbDump } from "./in-page/idb-dump.ts";
import {
    collectPerf,
    disposePerfObservers,
    installPerfObservers,
    type LoafFrame,
    resetPerfMarks,
} from "./in-page/perf-observers.ts";
import { spaNavigate } from "./in-page/spa-navigate.ts";
import { waitForCondition } from "./in-page/wait-for.ts";
import { webStorageDump } from "./in-page/web-storage.ts";
import { attachSourceMap, globToRegExp, rewriteResponses } from "./intercept.ts";
import { reactFind } from "./libraries/react/in-page/react-find.ts";
import { waitForEvent } from "./perf.ts";
import { grantPermissions, isSecureOrigin, localNetworkBlockOf } from "./permissions.ts";
import { isDocumentReplaced, waitForPage } from "./spa.ts";
import { copyOriginIndexedDb, deleteCookies, originStorageKey } from "./storage.ts";
import {
    cumulativeLayoutShift,
    distribution,
    groupByInvoker,
    interactionToNextPaint,
    invokerKind,
    topFrames,
} from "./summaries.ts";

const IN_PAGE = {
    reactFind,
    spaNavigate,
    waitForCondition,
    idbDump,
    webStorageDump,
    installPerfObservers,
    resetPerfMarks,
    collectPerf,
    disposePerfObservers,
    clearStorageKeys,
};

function frame(start: number, duration: number, invoker: string, invokerType: string, sourceURL = ""): LoafFrame {
    return {
        start,
        duration,
        blockingDuration: Math.max(0, duration - 50),
        renderStart: 0,
        styleAndLayoutStart: 0,
        scripts: invoker
            ? [
                  {
                      duration: duration - 5,
                      invoker,
                      invokerType,
                      sourceURL,
                      sourceFunctionName: "",
                      sourceCharPosition: 42,
                      forcedStyleAndLayoutDuration: 0,
                      pauseDuration: 0,
                  },
              ]
            : [],
    };
}

function fakeCdp(reply: unknown): CdpLike & { sent: Array<{ method: string; params?: Record<string, unknown> }> } {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
        sent,
        send(method, params) {
            sent.push({ method, params });
            return Promise.resolve(reply);
        },
        on() {
            return undefined;
        },
        off() {
            return undefined;
        },
    };
}

describe("in-page functions", () => {
    for (const [name, fn] of Object.entries(IN_PAGE)) {
        test(`${name} survives toString() in a clean context`, () => {
            const source = fn.toString();
            expect(source).not.toMatch(/__name\(|__require|__toESM|import\(/);
            expect(typeof runInNewContext(`(${source})`, {})).toBe("function");
        });
    }

    test("perf observers: the sampler sleeps past activeMs, and dispose stops everything they started", () => {
        const disconnected: string[] = [];
        const intervals = new Map<number, () => void>();
        const listeners = new Set<unknown>();
        let now = 0;
        class FakeObserver {
            static supportedEntryTypes = ["long-animation-frame", "longtask", "layout-shift", "event"];
            type = "";
            observe(options: { type: string }) {
                this.type = options.type;
            }

            disconnect() {
                disconnected.push(this.type);
            }
        }
        const page: Record<string, unknown> = {
            performance: { now: () => now },
            PerformanceObserver: FakeObserver,
            document: {
                visibilityState: "visible",
                addEventListener: (_event: string, listener: unknown) => listeners.add(listener),
                removeEventListener: (_event: string, listener: unknown) => listeners.delete(listener),
            },
            location: { pathname: "/" },
            setInterval: (fn: () => void) => {
                const id = intervals.size + 1;
                intervals.set(id, fn);
                return id;
            },
            clearInterval: (id: number) => intervals.delete(id),
        };
        page.window = page;
        const run = (fn: (arg: never) => unknown, arg: unknown) => {
            page.arg = arg;
            return runInNewContext(`(${fn.toString()})(arg)`, page);
        };

        run(installPerfObservers, { activeMs: 100 });
        expect(intervals.size).toBe(1);
        now = 200;
        for (const tick of [...intervals.values()]) {
            tick();
        }

        expect(intervals.size).toBe(0);
        run(resetPerfMarks, { activeMs: 100 });
        expect(intervals.size).toBe(1);

        expect(run(disposePerfObservers, {})).toEqual({ disposed: true });
        expect(disconnected.sort()).toEqual(["event", "layout-shift", "long-animation-frame", "longtask"]);
        expect(intervals.size).toBe(0);
        expect(listeners.size).toBe(0);
        expect(page.__gtPerf).toBeUndefined();
        expect(run(disposePerfObservers, {})).toEqual({ disposed: false });
    });

    test("reactFind matches several structured matchers in one walk and exposes the live owner", () => {
        const client = { getQueryCache: () => "cache" };
        const store = { getState: () => ({}) };
        function App() {}
        function QueryClientProvider() {}
        const hostRoot = { tag: 3, memoizedProps: null, child: null as unknown };
        const app = { type: App, memoizedProps: {}, return: hostRoot, child: null as unknown, sibling: null };
        const provider = {
            type: QueryClientProvider,
            memoizedProps: { client, children: [] },
            return: app,
            child: null as unknown,
            sibling: null,
        };
        const redux = {
            type: { displayName: "ReduxProvider" },
            memoizedProps: { store },
            return: provider,
            child: null,
        };
        hostRoot.child = app;
        app.child = provider;
        provider.child = redux;
        // The container key keeps the mount-time HostRoot; the committed tree hangs off its alternate.
        const staleHostRoot = { tag: 3, memoizedProps: null, child: null, stateNode: { current: hostRoot } };
        const element: Record<string, unknown> = { __reactContainer$abc: staleHostRoot };
        const window: Record<string, unknown> = {};
        const document = { querySelectorAll: () => [element] };

        const result = runInNewContext(`(${reactFind.toString()})(args)`, {
            document,
            window,
            args: {
                matchers: [
                    { name: "queryClient", hasFunction: "client.getQueryCache", exposeAs: "__qc" },
                    { name: "store", hasFunction: "store.getState" },
                    { name: "nothing", hasPath: "no.such.prop" },
                ],
            },
        });

        expect(result.error).toBeUndefined();
        expect(result.roots).toBe(1);
        expect(result.missing).toEqual(["nothing"]);
        const byName = Object.fromEntries(
            (result.matches as Array<{ matcher: string }>).map((match) => [match.matcher, match])
        );
        expect(byName.queryClient).toMatchObject({
            component: "QueryClientProvider",
            depth: 2,
            propPath: "client",
            exposedAs: "__qc",
            ancestors: ["App"],
        });
        expect(byName.store).toMatchObject({ component: "ReduxProvider", propPath: "store", exposedAs: null });
        expect(window.__qc).toBe(client);
    });
});

describe("perf summaries", () => {
    test("distribution interpolates percentiles", () => {
        expect(distribution([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({
            n: 10,
            min: 10,
            p50: 55,
            p90: 91,
            max: 100,
            mean: 55,
        });
        expect(distribution([]).n).toBe(0);
        expect(distribution([0.085, 0.0412]).max).toBe(0.085);
    });

    test("invokerKind names what started a script", () => {
        expect(invokerKind({ invoker: "Response.json.then", invokerType: "resolve-promise" })).toBe(
            "Response.json.then"
        );
        expect(invokerKind({ invoker: "TimerHandler:setTimeout", invokerType: "user-callback" })).toBe(
            "TimerHandler:setTimeout"
        );
        expect(invokerKind({ invoker: "BUTTON#save.onclick", invokerType: "event-listener" })).toBe(
            "event-listener:BUTTON.onclick"
        );
        expect(invokerKind({ invoker: "MessagePort.onmessage", invokerType: "event-listener" })).toBe(
            "event-listener:MessagePort.onmessage"
        );
        expect(invokerKind({ invoker: "Worker.onmessage", invokerType: "event-listener" })).toBe(
            "event-listener:Worker.onmessage"
        );
        expect(invokerKind({ invoker: "https://app.example.com/main.js", invokerType: "classic-script" })).toBe(
            "classic-script"
        );
    });

    test("groupByInvoker attributes each frame to its top script and ranks by total time", () => {
        const frames = [
            frame(100, 450, "Response.json.then", "resolve-promise", "https://app.example.com/static/js/api.js"),
            frame(700, 120, "Response.json.then", "resolve-promise", "https://app.example.com/static/js/api.js"),
            frame(900, 300, "TimerHandler:setTimeout", "user-callback", "https://app.example.com/static/js/a.js"),
            frame(1300, 60, "", ""),
        ];
        const groups = groupByInvoker(frames);
        expect(groups.map((group) => [group.kind, group.frames, group.totalMs])).toEqual([
            ["Response.json.then", 2, 570],
            ["TimerHandler:setTimeout", 1, 300],
            ["rendering", 1, 60],
        ]);
        expect(groups[0].sources).toEqual([{ location: "/static/js/api.js:42", ms: 560 }]);
        expect(topFrames(frames, 1)[0]).toMatchObject({ duration: 450, kind: "Response.json.then" });
        expect(topFrames(frames, 1)[0].source).toEqual({ url: "https://app.example.com/static/js/api.js", offset: 42 });
        expect(topFrames(frames, 4)[3].source).toBeNull();
    });

    test("CLS takes the largest session window and skips input-driven shifts", () => {
        const shift = (start: number, value: number, hadRecentInput = false) => ({
            start,
            value,
            hadRecentInput,
            sources: [],
        });
        expect(cumulativeLayoutShift([shift(0, 0.1), shift(500, 0.1), shift(3000, 0.05), shift(3100, 0.5, true)])).toBe(
            0.2
        );
    });

    test("INP is the worst interaction below 50 interactions", () => {
        const event = (interactionId: number, duration: number) => ({
            name: "click",
            start: 0,
            duration,
            inputDelay: 1,
            processing: 1,
            interactionId,
            target: null,
        });
        expect(interactionToNextPaint([event(1, 80), event(1, 120), event(2, 200), event(0, 900)])).toBe(200);
        expect(interactionToNextPaint([])).toBeNull();
    });
});

describe("A/B harness", () => {
    const variants = [{ name: "a" }, { name: "b" }, { name: "c" }];

    test("abba reverses every other round", () => {
        expect(
            abSchedule(variants, 3)
                .map((run) => run.variant.name)
                .join("")
        ).toBe("abccbaabc");
        expect(
            abSchedule(variants, 2, "same")
                .map((run) => run.variant.name)
                .join("")
        ).toBe("abcabc");
    });

    test("runAb records failures, always tears down, persists after every run, summarizes per variant", async () => {
        const log: string[] = [];
        let persisted = 0;
        const result = await runAb({
            variants: [
                { name: "fast", config: 10 },
                { name: "slow", config: 30 },
            ],
            rounds: 3,
            setup: (run) => {
                log.push(`setup ${run.variant.name}`);
            },
            measure: async (run) => {
                if (run.index === 2) {
                    throw new Error("page crashed");
                }

                return { ms: (run.variant.config ?? 0) + run.round };
            },
            metrics: (sample) => ({ ms: sample.ms }),
            teardown: (run) => {
                log.push(`teardown ${run.variant.name}`);
            },
            onSample: (_sample, all) => {
                persisted = all.length;
            },
        });

        expect(result.samples.map((sample) => sample.error ?? sample.metrics?.ms)).toEqual([
            11,
            31,
            "page crashed",
            12,
            13,
            33,
        ]);
        expect(log.filter((line) => line.startsWith("teardown"))).toHaveLength(6);
        expect(persisted).toBe(6);
        expect(result.summary.map((variant) => [variant.variant, variant.runs, variant.failed])).toEqual([
            ["fast", 3, 0],
            ["slow", 3, 1],
        ]);
        expect(result.summary[0].metrics.ms).toMatchObject({ n: 3, min: 11, p50: 12, max: 13 });
    });

    test("an aborted signal stops before the next run", async () => {
        const controller = new AbortController();
        const result = await runAb({
            variants,
            rounds: 2,
            measure: async () => {
                controller.abort();
                return 1;
            },
            metrics: (value) => ({ value }),
            signal: controller.signal,
        });
        expect(result.aborted).toBe(true);
        expect(result.samples).toHaveLength(1);
    });
});

describe("intercept patterns", () => {
    test("globToRegExp follows Fetch.enable wildcards and escapes", () => {
        expect(globToRegExp("*/config.js*").test("https://app.example.com/col/config.js?v=1")).toBe(true);
        expect(globToRegExp("*/config.js*").test("https://app.example.com/col/configXjs")).toBe(false);
        expect(globToRegExp("https://app.example.com/?").test("https://app.example.com/a")).toBe(true);
        expect(globToRegExp("*\\?x=1").test("https://app.example.com/?x=1")).toBe(true);
    });

    test("a rewritten response keeps every repeated header and drops the stale length and encoding", async () => {
        const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
        let paused: ((params: unknown) => void) | undefined;
        const cdp: CdpLike = {
            send(method, params) {
                sent.push({ method, params });
                return Promise.resolve(method === "Fetch.getResponseBody" ? { body: "old", base64Encoded: false } : {});
            },
            on(_event, listener) {
                paused = listener;
            },
            off() {
                return undefined;
            },
        };
        const handle = await rewriteResponses(cdp, [{ urlPattern: "*", transform: (body) => `${body}+new` }]);
        paused?.({
            requestId: "r1",
            request: { url: "https://app.example.com/a.js", method: "GET" },
            resourceType: "Script",
            responseStatusCode: 200,
            responseHeaders: [
                { name: "Set-Cookie", value: "a=1" },
                { name: "Set-Cookie", value: "b=2" },
                { name: "Content-Length", value: "3" },
                { name: "Content-Encoding", value: "gzip" },
                { name: "Cache-Control", value: "max-age=60" },
            ],
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await handle.stop();
        const fulfilled = sent.find((call) => call.method === "Fetch.fulfillRequest");
        expect(fulfilled?.params?.responseHeaders).toEqual([
            { name: "Set-Cookie", value: "a=1" },
            { name: "Set-Cookie", value: "b=2" },
            { name: "cache-control", value: "no-store" },
        ]);
        expect(Buffer.from(String(fulfilled?.params?.body), "base64").toString("utf8")).toBe("old+new");
    });
});

describe("waitForEvent", () => {
    function eventCdp() {
        const listeners = new Set<(params: unknown) => void>();
        const cdp: CdpLike = {
            send: () => Promise.resolve({}),
            on: (_event, listener) => listeners.add(listener),
            off: (_event, listener) => listeners.delete(listener),
        };
        return { cdp, listeners };
    }

    test("the event resolves the wait and removes its listener", async () => {
        const { cdp, listeners } = eventCdp();
        const wait = waitForEvent(cdp, "Page.loadEventFired", 60_000);
        for (const listener of listeners) {
            listener({ timestamp: 1 });
        }

        expect(await wait.done).toEqual({ timestamp: 1 });
        expect(listeners.size).toBe(0);
    });

    test("cancel settles the wait at once, so it never rejects unhandled at the deadline", async () => {
        const { cdp, listeners } = eventCdp();
        const wait = waitForEvent(cdp, "Page.loadEventFired", 60_000);
        wait.cancel();
        expect(listeners.size).toBe(0);
        await expect(wait.done).rejects.toThrow("was cancelled");
    });
});

describe("clearStorageKeys", () => {
    test("with origins, a document of another origin keeps its storage", () => {
        const run = (origin: string) => {
            const items = new Map([["flag", "1"]]);
            const storage = {
                getItem: (name: string) => items.get(name) ?? null,
                removeItem: (name: string) => items.delete(name),
            };
            const page = { location: { origin }, localStorage: storage, sessionStorage: storage };
            return runInNewContext(`(${clearStorageKeys.toString()})(args)`, {
                ...page,
                args: { localStorage: ["flag"], origins: ["https://app.example.com"] },
            });
        };

        expect(run("https://app.example.com")).toEqual({ removed: ["local:flag"] });
        expect(run("https://login.example.net")).toEqual({ removed: [] });
    });
});

describe("deleteCookies", () => {
    test("with a domain, only that site's cookies go: its host, parent domains and subdomains", async () => {
        const cookies = [
            { name: "session", domain: "app.example.com", path: "/" },
            { name: "session", domain: ".example.com", path: "/" },
            { name: "session", domain: "api.app.example.com", path: "/" },
            { name: "session", domain: "other.example.com", path: "/" },
            { name: "session", domain: "notexample.com", path: "/" },
            { name: "theme", domain: "app.example.com", path: "/" },
        ];
        const cdp = fakeCdp({ cookies });
        expect(await deleteCookies(cdp, { names: ["session"], domain: "app.example.com" })).toBe(3);
        expect(
            cdp.sent.filter((call) => call.method === "Network.deleteCookies").map((call) => call.params?.domain)
        ).toEqual(["app.example.com", ".example.com", "api.app.example.com"]);
    });
});

describe("callInPage", () => {
    test("sends Runtime.evaluate with the function and its JSON argument, returns the value", async () => {
        const cdp = fakeCdp({ result: { type: "object", value: { ok: true } } });
        const value = await callInPage(cdp, (arg: { n: number }) => ({ ok: arg.n === 1 }), { n: 1 });
        expect(value).toEqual({ ok: true });
        expect(cdp.sent[0].method).toBe("Runtime.evaluate");
        expect(cdp.sent[0].params).toMatchObject({ awaitPromise: true, returnByValue: true });
        expect(String(cdp.sent[0].params?.expression)).toEndWith(`({"n":1})`);
    });

    test("the transport is told to wait as long as the call may take", async () => {
        const deadlines: Array<number | undefined> = [];
        const cdp: CdpLike = {
            send(_method, _params, options) {
                deadlines.push(options?.timeoutMs);
                return Promise.resolve({ result: { type: "number", value: 1 } });
            },
            on() {
                return undefined;
            },
            off() {
                return undefined;
            },
        };
        await callInPage(cdp, () => 1, undefined, { timeoutMs: 120_000 });
        await callInPage(cdp, () => 1, undefined);
        expect(deadlines).toEqual([121_000, 31_000]);
    });

    test("a page exception becomes an InPageError with its description", async () => {
        const cdp = fakeCdp({ exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } } });
        await expect(callInPage(cdp, () => 1, undefined)).rejects.toThrow(new InPageError("Error: boom"));
    });

    test("a wait survives a redirect: the document is replaced once, the wait runs again in the new one", async () => {
        let calls = 0;
        const cdp: CdpLike = {
            send() {
                calls++;
                return calls === 1
                    ? Promise.reject(new Error('{"code":-32000,"message":"Inspected target navigated or closed"}'))
                    : Promise.resolve({ result: { type: "object", value: { ok: true, ms: 3 } } });
            },
            on: () => undefined,
            off: () => undefined,
        };
        const settled = await waitForPage(cdp, { selector: "main" }, 3000);
        expect(settled.ok).toBe(true);
        expect(calls).toBe(2);
        expect(isDocumentReplaced(new Error("Execution context was destroyed."))).toBe(true);
        expect(isDocumentReplaced(new Error("boom"))).toBe(false);
    });

    test("the expression of a function without an argument calls it with none", () => {
        expect(inPageExpression(() => 1)).toBe("(() => 1)()");
    });
});

describe("profile IndexedDB copy", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("originStorageKey follows Chromium's folder names", () => {
        expect(originStorageKey("https://app.example.com")).toBe("https_app.example.com_0");
        expect(originStorageKey("https://app.example.com/some/path")).toBe("https_app.example.com_0");
        expect(originStorageKey("http://localhost:3000")).toBe("http_localhost_3000");
    });

    test("copies leveldb and blob folders without LOCK and refuses to overwrite", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-idb-copy-"));
        dirs.push(root);
        const leveldb = join(root, "profile", "IndexedDB", "https_app.example.com_0.indexeddb.leveldb");
        const blob = join(root, "profile", "IndexedDB", "https_app.example.com_0.indexeddb.blob", "1");
        mkdirSync(leveldb, { recursive: true });
        mkdirSync(blob, { recursive: true });
        writeFileSync(join(leveldb, "000003.log"), "x".repeat(100));
        writeFileSync(join(leveldb, "CURRENT"), "MANIFEST-000001\n");
        writeFileSync(join(leveldb, "LOCK"), "");
        writeFileSync(join(blob, "00"), "blob");

        const options = {
            profileDir: join(root, "profile"),
            origin: "https://app.example.com",
            userDataDir: join(root, "scratch"),
        };
        const result = await copyOriginIndexedDb(options);

        const target = join(root, "scratch", "Default", "IndexedDB", "https_app.example.com_0.indexeddb.leveldb");
        expect(readdirSync(target).sort()).toEqual(["000003.log", "CURRENT"]);
        expect(
            existsSync(join(root, "scratch", "Default", "IndexedDB", "https_app.example.com_0.indexeddb.blob"))
        ).toBe(true);
        expect(result.copied.map((folder) => folder.files)).toEqual([2, 1]);
        expect(result.onDiskBytes).toBe(100 + 16 + 4);
        await expect(copyOriginIndexedDb(options)).rejects.toThrow("already exists");
        await expect(copyOriginIndexedDb({ ...options, origin: "https://other.example.com" })).rejects.toThrow(
            "no IndexedDB"
        );
    });
});

describe("attachSourceMap", () => {
    test("replaces the old reference with an inline map the page cannot tell from the original", () => {
        const map = '{"version":3,"sources":["a.ts"],"mappings":""}';
        const out = attachSourceMap("run();\n//# sourceMappingURL=main.js.map", map);
        expect(out.startsWith("run();\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,")).toBe(true);
        expect(out.match(/sourceMappingURL/g)).toHaveLength(1);
        const encoded = out.trim().split("base64,")[1] ?? "";
        expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(map);
    });
});

describe("permissions", () => {
    test("only https, and http on loopback hosts, count as secure origins", () => {
        expect(isSecureOrigin("https://app.example.com")).toBe(true);
        expect(isSecureOrigin("http://localhost:3000")).toBe(true);
        expect(isSecureOrigin("http://127.0.0.1:8080")).toBe(true);
        expect(isSecureOrigin("http://app.example.com")).toBe(false);
        expect(isSecureOrigin("not a url")).toBe(false);
    });

    test("each name is granted in the tab's browser context, and a refusal is reported, not swallowed", async () => {
        const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
        const cdp: CdpLike = {
            async send(method: string, params?: Record<string, unknown>) {
                calls.push({ method, params: params ?? {} });
                if (method === "Target.getTargetInfo") {
                    return { targetInfo: { browserContextId: "ctx-1" } };
                }

                const name = (params?.permission as { name?: string } | undefined)?.name;
                if (name === "localNetworkAccess") {
                    throw new Error("Invalid PermissionDescriptor name: localNetworkAccess");
                }

                return {};
            },
            on: () => () => undefined,
        } as unknown as CdpLike;
        const results = await grantPermissions(cdp, {
            origin: "https://app.example.com",
            names: ["local-network", "localNetworkAccess"],
        });
        expect(results).toEqual([
            { name: "local-network", granted: true },
            {
                name: "localNetworkAccess",
                granted: false,
                error: "Invalid PermissionDescriptor name: localNetworkAccess",
            },
        ]);
        expect(calls[1]).toEqual({
            method: "Browser.setPermission",
            params: {
                permission: { name: "local-network" },
                setting: "granted",
                origin: "https://app.example.com",
                browserContextId: "ctx-1",
            },
        });
    });

    test("a Local Network Access block is recognised by its CORS error, other failures are not", () => {
        expect(localNetworkBlockOf({ corsErrorStatus: { corsError: "LocalNetworkAccessPermissionDenied" } })).toBe(
            "LocalNetworkAccessPermissionDenied"
        );
        expect(localNetworkBlockOf({ corsErrorStatus: { corsError: "MissingAllowOriginHeader" } })).toBeNull();
        expect(localNetworkBlockOf({ errorText: "net::ERR_CONNECTION_REFUSED" })).toBeNull();
        expect(
            localNetworkBlockOf({ type: "Preflight", errorText: "net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS" })
        ).toBe("net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS");
        expect(localNetworkBlockOf({ errorText: "net::ERR_BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS" })).toBe(
            "net::ERR_BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS"
        );
        expect(localNetworkBlockOf({ errorText: "net::ERR_BLOCKED_BY_CLIENT" })).toBeNull();
    });
});
