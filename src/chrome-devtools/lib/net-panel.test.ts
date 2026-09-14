import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { sanitizeHar } from "./har-io.ts";
import {
    AmbiguousDevToolsTargetError,
    devtoolsSubject,
    disambiguatingMatch,
    hostOf,
    NoDevToolsTargetError,
    PANEL_DUMP_SCRIPT,
    type PanelDump,
    pageSubject,
    panelDumpToHar,
    parsePanelDump,
    pickDevToolsTarget,
    stripUrl,
    subjectEquals,
    subjectMatches,
    summarizePanel,
    withDeadline,
} from "./net-panel.ts";

/** Every open inspector reports this exact url — which is precisely why it cannot identify one. */
const DEVTOOLS_URL = "devtools://devtools/bundled/devtools_app.html?targetType=tab";

function target(over: { title?: string; url: string; id?: string; type?: string }) {
    return {
        id: over.id ?? over.url,
        type: over.type ?? "page",
        title: over.title ?? "",
        url: over.url,
        webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${over.id ?? "x"}`,
    };
}

describe("pickDevToolsTarget", () => {
    // The live shape: the inspected tab plus TWO inspectors that share one url.
    const list = [
        target({ title: "Search OP", url: "https://app.uat.example.com/portal/search-op#/" }),
        target({ title: "Colleagues", url: "https://intranet.example.com/col/" }),
        target({ title: "DevTools - app.uat.example.com/portal/search-op", url: DEVTOOLS_URL, id: "dt-app" }),
        target({ title: "DevTools - intranet.example.com/col/", url: DEVTOOLS_URL, id: "dt-intranet" }),
    ];

    test("a page substring that hits exactly one inspector title picks that inspector", () => {
        const pick = pickDevToolsTarget(list, "search-op");

        expect(pick.devtools.id).toBe("dt-app");
        expect(pick.via).toBe("title");
    });

    test("an explicit 'DevTools - <host>' match picks that inspector and no other", () => {
        expect(pickDevToolsTarget(list, "DevTools - intranet.example.com").devtools.id).toBe("dt-intranet");
    });

    test("when the match hits BOTH inspector titles it resolves through the inspected page", () => {
        // "example.com" sits in both inspector titles, so the title route is ambiguous and
        // must not be allowed to grab whichever one happens to come first.
        const ambiguous = [
            target({ title: "Colleagues", url: "https://intranet.example.com/col/" }),
            target({ title: "DevTools - app.uat.example.com/portal/search-op", url: DEVTOOLS_URL, id: "dt-app" }),
            target({ title: "DevTools - intranet.example.com/col/", url: DEVTOOLS_URL, id: "dt-intranet" }),
        ];
        const pick = pickDevToolsTarget(ambiguous, "example.com");

        expect(pick.devtools.id).toBe("dt-intranet");
        expect(pick.via).toBe("page");
        expect(pick.page?.url).toBe("https://intranet.example.com/col/");
    });

    test("never falls back to a random inspector when nothing ties to the match", () => {
        try {
            pickDevToolsTarget(list, "billing.example.com");
            throw new Error("expected a NoDevToolsTargetError");
        } catch (err) {
            expect(err).toBeInstanceOf(NoDevToolsTargetError);
            expect((err as NoDevToolsTargetError).inspectorTitles).toHaveLength(2);
        }
    });

    test("an open tab with no inspector reports the page it found, so the CLI can say which one to open", () => {
        const noInspector = [target({ title: "Search OP", url: "https://app.uat.example.com/portal/search-op#/" })];

        try {
            pickDevToolsTarget(noInspector, "search-op");
            throw new Error("expected a NoDevToolsTargetError");
        } catch (err) {
            expect((err as NoDevToolsTargetError).page?.url).toBe("https://app.uat.example.com/portal/search-op#/");
            expect((err as NoDevToolsTargetError).inspectorTitles).toHaveLength(0);
        }
    });

    test("the inspected page is matched by title too, not only by url", () => {
        const pick = pickDevToolsTarget(list, "Colleagues");

        expect(pick.devtools.id).toBe("dt-intranet");
        expect(pick.via).toBe("page");
    });

    // A page on the site root normalizes to the bare host, and a bare host is a prefix of
    // every inspector subject on that host. Taking the first hit read a DIFFERENT tab's
    // network log and said nothing about it.
    const sameHost = [
        target({ title: "Home", url: "https://app.example.com/" }),
        target({ title: "Admin", url: "https://app.example.com/admin" }),
        target({ title: "DevTools - app.example.com/admin", url: DEVTOOLS_URL, id: "dt-admin" }),
        target({ title: "DevTools - app.example.com/", url: DEVTOOLS_URL, id: "dt-home" }),
    ];

    test("a root-path tab lands on its OWN inspector, not on the first sibling that shares the host", () => {
        // dt-admin is listed first and its subject starts with the whole root subject, so
        // a plain prefix walk returned it and read the /admin tab's log instead.
        const pick = pickDevToolsTarget(sameHost, "Home");

        expect(pick.devtools.id).toBe("dt-home");
        expect(pick.via).toBe("page");
    });

    test("a substring that names two tabs refuses before it ever looks at an inspector", () => {
        // "example.com" is in both tab urls. Reading the first tab's panel would answer a
        // question the caller did not ask, and nothing in the output would say which tab.
        try {
            pickDevToolsTarget(sameHost, "example.com");
            throw new Error("expected an AmbiguousDevToolsTargetError");
        } catch (err) {
            expect(err).toBeInstanceOf(AmbiguousDevToolsTargetError);
            expect((err as AmbiguousDevToolsTargetError).kind).toBe("tab");
            expect((err as AmbiguousDevToolsTargetError).candidates).toEqual([
                "https://app.example.com/",
                "https://app.example.com/admin",
            ]);
        }
    });

    test("an explicit inspector title still wins even when several tabs match", () => {
        // Step 1 is untouched by the tab-ambiguity guard: naming the window is exact.
        const pick = pickDevToolsTarget(sameHost, "DevTools - app.example.com/admin");

        expect(pick.devtools.id).toBe("dt-admin");
        expect(pick.via).toBe("title");
    });

    test("a root-path tab with no inspector of its own refuses rather than borrowing a sibling's", () => {
        const noRootInspector = [
            target({ title: "Home", url: "https://app.example.com/" }),
            target({ title: "DevTools - app.example.com/admin", url: DEVTOOLS_URL, id: "dt-admin" }),
            target({ title: "DevTools - app.example.com/billing", url: DEVTOOLS_URL, id: "dt-billing" }),
        ];

        try {
            pickDevToolsTarget(noRootInspector, "Home");
            throw new Error("expected an AmbiguousDevToolsTargetError");
        } catch (err) {
            expect(err).toBeInstanceOf(AmbiguousDevToolsTargetError);
            expect((err as AmbiguousDevToolsTargetError).kind).toBe("inspector");
            expect((err as AmbiguousDevToolsTargetError).candidates).toHaveLength(2);
            expect((err as AmbiguousDevToolsTargetError).page?.url).toBe("https://app.example.com/");
        }
    });

    test("a genuinely truncated title is still followed when it is the only candidate", () => {
        const truncated = [
            target({ title: "Search OP", url: "https://app.example.com/portal/search-op" }),
            target({ title: "DevTools - app.example.com/portal/search-o", url: DEVTOOLS_URL, id: "dt-trunc" }),
        ];

        const pick = pickDevToolsTarget(truncated, "Search OP");
        expect(pick.devtools.id).toBe("dt-trunc");
        // Accepted, but on a prefix rather than on the subject, so the CLI must say so.
        expect(pick.exactSubject).toBe(false);
    });

    test("an inspector open on a SHORTER path is flagged as a guess, not passed off as the tab's own", () => {
        // The truncation allowance and "DevTools is open on the site root, the caller asked
        // about /admin" are the same shape. The pick is allowed; calling it exact is not.
        const rootInspectorOnly = [
            target({ title: "Home", url: "https://app.example.com/" }),
            target({ title: "Admin", url: "https://app.example.com/admin" }),
            target({ title: "DevTools - app.example.com", url: DEVTOOLS_URL, id: "dt-root" }),
        ];
        const pick = pickDevToolsTarget(rootInspectorOnly, "app.example.com/admin");

        expect(pick.devtools.id).toBe("dt-root");
        expect(pick.page?.url).toBe("https://app.example.com/admin");
        expect(pick.exactSubject).toBe(false);
    });

    test("an exact subject and a named inspector are both exact, so neither is warned about", () => {
        expect(pickDevToolsTarget(sameHost, "Home").exactSubject).toBe(true);
        expect(pickDevToolsTarget(sameHost, "DevTools - app.example.com/admin").exactSubject).toBe(true);
    });
});

describe("disambiguatingMatch", () => {
    /**
     * The suggestion is a `--match` value, and `--match` is a substring test. Handing back
     * the first tied candidate re-runs into the same tie when it is a prefix of the second,
     * which is the ordinary shape: a site root beside one of its sub-paths.
     */
    function rerun(list: ReturnType<typeof target>[], wanted: string) {
        try {
            const first = pickDevToolsTarget(list, wanted);

            return { resolved: first.devtools.title, error: null as string | null };
        } catch (err) {
            if (err instanceof AmbiguousDevToolsTargetError) {
                const only = disambiguatingMatch(err.candidates);

                if (only === null) {
                    return { resolved: null, error: "refused" };
                }

                return rerun(list, only);
            }

            return { resolved: null, error: err instanceof Error ? err.name : String(err) };
        }
    }

    test("the suggested tab resolves instead of reprinting the same tie", () => {
        const list = [
            target({ title: "Home", url: "https://app.example.com/" }),
            target({ title: "Admin", url: "https://app.example.com/admin" }),
            target({ title: "DevTools - app.example.com/", url: DEVTOOLS_URL, id: "dt-root" }),
            target({ title: "DevTools - app.example.com/admin", url: DEVTOOLS_URL, id: "dt-admin" }),
        ];

        // The first candidate, "https://app.example.com/", is a substring of the second,
        // so suggesting it would print the error it was meant to resolve.
        expect(disambiguatingMatch(["https://app.example.com/", "https://app.example.com/admin"])).toBe(
            "https://app.example.com/admin"
        );
        expect(rerun(list, "app.example.com")).toEqual({
            resolved: "DevTools - app.example.com/admin",
            error: null,
        });
    });

    test("the suggested inspector resolves instead of degrading into 'no DevTools window'", () => {
        const list = [
            target({ title: "Home", url: "https://app.example.com/" }),
            target({ title: "DevTools - app.example.com/admin", url: DEVTOOLS_URL, id: "dt-admin" }),
            target({ title: "DevTools - app.example.com/admin/users", url: DEVTOOLS_URL, id: "dt-users" }),
        ];

        expect(rerun(list, "app.example.com/")).toEqual({
            resolved: "DevTools - app.example.com/admin/users",
            error: null,
        });
    });

    test("identical candidates are refused rather than given an impossible command", () => {
        expect(disambiguatingMatch(["https://app.example.com/dash", "https://app.example.com/dash"])).toBeNull();
        expect(disambiguatingMatch([])).toBeNull();
    });

    test("a shorter duplicate does not block a unique longest candidate", () => {
        expect(
            disambiguatingMatch(["https://a.example.com/x", "https://a.example.com/x", "https://a.example.com/xy"])
        ).toBe("https://a.example.com/xy");
    });
});

describe("title and url subjects", () => {
    test("strips the DevTools prefix and rejects anything that is not an inspector title", () => {
        expect(devtoolsSubject("DevTools - app.example.com/portal")).toBe("app.example.com/portal");
        expect(devtoolsSubject("Search OP")).toBeNull();
        expect(devtoolsSubject("DevTools - ")).toBeNull();
    });

    test("a page subject is host+path with the fragment dropped", () => {
        expect(pageSubject("https://app.example.com/portal/search#/tab/2")).toBe("app.example.com/portal/search");
        expect(pageSubject("not a url")).toBeNull();
    });

    test("a truncated inspector title still matches its page, an empty one never matches", () => {
        expect(subjectMatches("app.example.com/portal/sea", "app.example.com/portal/search")).toBe(true);
        expect(subjectMatches("app.example.com/", "app.example.com")).toBe(true);
        expect(subjectMatches("other.example.com/x", "app.example.com/portal")).toBe(false);
        expect(subjectMatches(null, "app.example.com")).toBe(false);
        expect(subjectMatches("", "app.example.com")).toBe(false);
    });

    test("equality ignores the trailing slash but never accepts a mere prefix", () => {
        expect(subjectEquals("app.example.com/", "app.example.com")).toBe(true);
        expect(subjectEquals("APP.example.com/portal", "app.example.com/portal")).toBe(true);
        expect(subjectEquals("app.example.com/admin", "app.example.com")).toBe(false);
        expect(subjectEquals(null, "app.example.com")).toBe(false);
        expect(subjectEquals("", "app.example.com")).toBe(false);
    });
});

describe("PANEL_DUMP_SCRIPT", () => {
    test("uses the NESTED NetworkLog export, not the module object", () => {
        expect(PANEL_DUMP_SCRIPT).toContain("logs.NetworkLog.NetworkLog");
        expect(PANEL_DUMP_SCRIPT).toContain('await import("./models/logs/logs.js")');
    });

    test("calls the url getter ON the request instead of unbinding it", () => {
        // `const f = r.url; f()` throws "Cannot read properties of undefined (reading '#N')"
        // because the getter reads private fields off `this`.
        expect(PANEL_DUMP_SCRIPT).toContain("v.call(obj)");
    });

    test("collects no headers, cookies or post bodies at all", () => {
        for (const forbidden of ["requestHeaders", "responseHeaders", "requestFormData", "cookies", "postData"]) {
            expect(PANEL_DUMP_SCRIPT).not.toContain(forbidden);
        }
    });
});

describe("stripUrl", () => {
    test("drops the query string, where OAuth codes live", () => {
        expect(stripUrl("https://auth.example.com/callback?code=abc123&state=xyz")).toBe(
            "https://auth.example.com/callback"
        );
    });

    test("drops the fragment, where implicit-flow tokens live", () => {
        expect(stripUrl("https://app.example.com/#access_token=secret-value&token_type=bearer")).toBe(
            "https://app.example.com/"
        );
    });

    test("an unparseable url still loses everything after ? and #", () => {
        expect(stripUrl("weird::/thing?code=abc#access_token=zzz")).toBe("weird::/thing");
    });

    test("hostOf survives garbage instead of throwing", () => {
        expect(hostOf("https://app.example.com/x")).toBe("app.example.com");
        expect(hostOf("nonsense")).toBe("(unparsed)");
    });

    // These schemes have an opaque origin, so the old code fell through to the textual
    // cut and reprinted the whole url. There is no "?" in a data: payload to cut at.
    test("a data: url names its type instead of reprinting the payload", () => {
        expect(stripUrl("data:text/html,<script>const t='SUPERSECRET'</script>")).toBe(
            "data:text/html,[payload dropped]"
        );
        expect(stripUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg")).toBe("data:image/png,[payload dropped]");
    });

    test("a javascript: url never reprints its inline code", () => {
        // A comma inside the code used to survive as "javascript:fetch('/x'," because the
        // data: mediatype rule was applied to it. Inline code has no safe prefix at all.
        const stripped = stripUrl("javascript:fetch('/x',{headers:{Authorization:'Bearer SECRET'}})");

        expect(stripped).toBe("javascript:[inline code dropped]");
        expect(stripped).not.toContain("SECRET");
        expect(stripped).not.toContain("fetch");
    });

    test("a data: url with no mediatype still says nothing about its payload", () => {
        expect(stripUrl("data:,SECRET-INLINE")).toBe("data:[payload dropped]");
    });

    test("a blob: url keeps one origin instead of gluing two together", () => {
        // origin + pathname produced "https://app.example.comhttps://app.example.com/9f0e".
        expect(stripUrl("blob:https://app.example.com/9f0e-1234")).toBe("blob:https://app.example.com/9f0e-1234");
        expect(stripUrl("blob:https://app.example.com/9f0e?code=abc")).toBe("blob:https://app.example.com/9f0e");
    });

    test("url credentials never reach the summary or the HAR", () => {
        // `https://user:pass@host/` is a real shape in intranet captures, and neither the
        // ?/# cut nor the sanitizer would touch it — only `origin` drops the userinfo, so
        // the property holds by construction and is pinned here rather than left to chance.
        const stripped = stripUrl("https://svc-account:hunter2@app.example.com/portal");

        expect(stripped).toBe("https://app.example.com/portal");
        expect(stripped).not.toContain("hunter2");
        expect(stripped).not.toContain("svc-account");
    });

    test("file: and extension urls keep their path but lose the query", () => {
        expect(stripUrl("file:///Users/tester/notes.txt?token=zzz")).toBe("file:///Users/tester/notes.txt");
        expect(stripUrl("chrome-extension://abcdefghij/panel.html?token=zzz")).toBe(
            "chrome-extension://abcdefghij/panel.html"
        );
    });
});

describe("withDeadline", () => {
    test("a read that never answers fails on the deadline instead of hanging", async () => {
        const forever = new Promise<string>(() => {});

        await expect(withDeadline(forever, 20, "the DevTools frontend did not answer")).rejects.toThrow(
            "did not answer"
        );
    });

    test("a read that answers in time is returned untouched", async () => {
        await expect(withDeadline(Promise.resolve("rows"), 5_000, "unused")).resolves.toBe("rows");
    });

    /**
     * This case used to claim it pinned "no unhandled rejection", and it pinned nothing:
     * removing `withDeadline`'s own `work.catch` left it green. `Promise.race` subscribes to
     * every promise it is handed, so the loser's rejection is already handled — verified with
     * a live `process.on("unhandledRejection")` listener, which fired 0 times for the no-catch
     * form and once for a plain rejected promise in the same process.
     *
     * What IS observable, and what the verb depends on, is that a late rejection cannot
     * overwrite the deadline outcome the caller already acted on.
     */
    test("a late rejection cannot overturn the deadline the caller already saw", async () => {
        let boom: (err: Error) => void = () => {};
        const late = new Promise<string>((_, reject) => {
            boom = reject;
        });
        const raced = withDeadline(late, 20, "deadline");

        await expect(raced).rejects.toThrow("deadline");
        boom(new Error("late failure"));
        await Bun.sleep(50);

        // Still the deadline error, not the later one: net-panel's catch branches on this
        // message to tell a wedged frontend apart from a wrong module shape.
        await expect(raced).rejects.toThrow("deadline");
    });
});

function row(over: Partial<PanelDump["rows"][number]> = {}) {
    return {
        url: "https://app.example.com/api/items",
        method: "GET",
        status: 200,
        resourceType: "xhr",
        mimeType: "application/json",
        startTime: 10,
        endTime: 10.25,
        wallIssueTime: 0,
        transferSize: 512,
        resourceSize: 1024,
        failed: false,
        fromCache: false,
        ...over,
    };
}

describe("parsePanelDump", () => {
    test("reads the live shape and keeps the panel's own count", () => {
        const dump = parsePanelDump({ count: 631, inspector: "DevTools - app.example.com", rows: [row()] });

        expect(dump.count).toBe(631);
        expect(dump.rows).toHaveLength(1);
        expect(dump.rows[0].url).toBe("https://app.example.com/api/items");
    });

    test("a DevTools build that drops a field yields defaults, never a crash", () => {
        const dump = parsePanelDump({ rows: [{ url: "https://app.example.com/x" }, null, "junk"] });

        expect(dump.rows).toHaveLength(1);
        expect(dump.rows[0].status).toBe(0);
        expect(dump.rows[0].method).toBe("");
        expect(dump.count).toBe(1);
    });

    test("a non-object result says the panel may not be open rather than throwing a type error", () => {
        expect(() => parsePanelDump(undefined)).toThrow("Network panel");
    });
});

describe("summarizePanel", () => {
    const dump: PanelDump = {
        count: 4,
        inspector: "DevTools - app.example.com/portal",
        rows: [
            row({ url: "https://auth.example.com/oidc/authorize?code=abc123", resourceType: "Document", status: 302 }),
            row({ url: "https://app.example.com/portal#access_token=secret-value", resourceType: "Document" }),
            row({ url: "https://app.example.com/api/items", method: "POST", status: 500, failed: true }),
            row({ url: "https://cdn.example.com/app.js", resourceType: "script" }),
        ],
    };

    test("counts by host, method, status and resource type", () => {
        const summary = summarizePanel(dump);

        expect(summary.count).toBe(4);
        expect(summary.hosts["app.example.com"]).toBe(2);
        expect(summary.hosts["auth.example.com"]).toBe(1);
        expect(summary.methods.POST).toBe(1);
        expect(summary.statuses["302"]).toBe(1);
        expect(summary.failed).toBe(1);
    });

    test("document hops keep origin+pathname only", () => {
        const summary = summarizePanel(dump);

        expect(summary.documents).toHaveLength(2);
        expect(summary.documents[0].url).toBe("https://auth.example.com/oidc/authorize");
    });

    test("no secret from a query string or fragment survives into the summary", () => {
        const serialized = SafeJSON.stringify(summarizePanel(dump));

        expect(serialized).not.toContain("code=");
        expect(serialized).not.toContain("access_token");
        expect(serialized).not.toContain("abc123");
        expect(serialized).not.toContain("secret-value");
    });

    test("the document list is capped so a 600-row panel cannot flood stdout", () => {
        const many: PanelDump = {
            count: 100,
            inspector: "DevTools - app.example.com",
            rows: Array.from({ length: 100 }, (_, i) =>
                row({ url: `https://app.example.com/doc/${i}`, resourceType: "Document" })
            ),
        };

        expect(summarizePanel(many, { documentLimit: 5 }).documents).toHaveLength(5);
    });
});

describe("panelDumpToHar", () => {
    const dump: PanelDump = {
        count: 2,
        inspector: "DevTools - app.example.com",
        rows: [
            row({ url: "https://auth.example.com/callback?code=abc123&state=xyz", wallIssueTime: 1_757_000_000 }),
            row({ url: "https://app.example.com/#access_token=secret-value" }),
        ],
    };

    test("entries carry no headers, cookies or post body — they were never collected", () => {
        const har = panelDumpToHar(dump);

        for (const entry of har.log.entries) {
            expect(entry.request.headers).toHaveLength(0);
            expect(entry.request.cookies).toHaveLength(0);
            expect(entry.request.postData).toBeUndefined();
            expect(entry.response?.headers).toHaveLength(0);
            expect(entry.response?.cookies).toHaveLength(0);
        }
    });

    test("by default urls are stripped, so no code= or access_token reaches the file", () => {
        const serialized = SafeJSON.stringify(panelDumpToHar(dump));

        expect(serialized).not.toContain("code=");
        expect(serialized).not.toContain("access_token");
        expect(serialized).toContain("https://auth.example.com/callback");
    });

    test("with fullUrls the shared sanitizer still redacts the OAuth code", () => {
        const serialized = SafeJSON.stringify(sanitizeHar(panelDumpToHar(dump, { fullUrls: true })));

        expect(serialized).not.toContain("abc123");
        expect(serialized).toContain("[REDACTED]");
    });

    test("fullUrls does not reopen the inline-payload hole the default view closes", () => {
        // sanitizeHar() only redacts ?name=value pairs and the fragment. A data: url has
        // neither, so keeping it "full" would put the payload in the file untouched.
        const inline: PanelDump = {
            count: 2,
            inspector: "DevTools - app.example.com",
            rows: [
                row({ url: "data:text/html,<script>const t='INLINE-SECRET'</script>" }),
                row({ url: "javascript:fetch('/x',{headers:{Authorization:'Bearer HDR-SECRET'}})" }),
            ],
        };
        const serialized = SafeJSON.stringify(sanitizeHar(panelDumpToHar(inline, { fullUrls: true })));

        expect(serialized).not.toContain("INLINE-SECRET");
        expect(serialized).not.toContain("HDR-SECRET");
        expect(serialized).toContain("[payload dropped]");
        expect(serialized).toContain("[inline code dropped]");
    });

    test("fullUrls still keeps a real request's query string", () => {
        const real: PanelDump = {
            count: 1,
            inspector: "DevTools - app.example.com",
            rows: [row({ url: "https://app.example.com/search?q=keepme" })],
        };
        const har = panelDumpToHar(real, { fullUrls: true });

        expect(har.log.entries[0].request.url).toBe("https://app.example.com/search?q=keepme");
    });

    test("a wall-clock issue time becomes startedDateTime; without one the capture time is used", () => {
        const har = panelDumpToHar(dump, { capturedAt: new Date("2026-09-09T13:36:00.000Z") });

        expect(har.log.entries[0].startedDateTime).toBe(new Date(1_757_000_000 * 1000).toISOString());
        expect(har.log.entries[1].startedDateTime).toBe("2026-09-09T13:36:00.000Z");
    });

    test("duration comes from the panel's own start/end, and never goes negative", () => {
        const har = panelDumpToHar({
            count: 1,
            inspector: "x",
            rows: [row({ startTime: 10, endTime: 9 })],
        });

        expect(har.log.entries[0].time).toBe(0);
    });
});
