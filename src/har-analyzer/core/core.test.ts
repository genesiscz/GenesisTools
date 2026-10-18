import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    formatDashboard,
    formatEntryLine,
    formatPercent,
    printFormatted,
    truncatePath,
} from "@app/har-analyzer/core/formatter";
import { loadHarFile, parseHarFile } from "@app/har-analyzer/core/parser";
import {
    filterEntries,
    getEntriesForDomain,
    groupByDomain,
    matchStatus,
    parseEntryIndex,
} from "@app/har-analyzer/core/query-engine";
import { RefStoreManager } from "@app/har-analyzer/core/ref-store";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { HarEntry, HarFile, HarSession } from "@app/har-analyzer/types";
import { isInterestingMimeType } from "@app/har-analyzer/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage/storage";

interface EntrySpec {
    method?: string;
    url: string;
    status: number;
    statusText?: string;
    mimeType?: string;
    contentSize?: number;
    requestBodySize?: number;
    responseBodySize?: number;
    postMimeType?: string;
    redirectURL?: string;
    timeMs: number;
    startedSecond: number;
}

function harEntry(spec: EntrySpec): HarEntry {
    return {
        startedDateTime: `2026-10-05T08:00:0${spec.startedSecond}.000Z`,
        time: spec.timeMs,
        request: {
            method: spec.method ?? "GET",
            url: spec.url,
            httpVersion: "HTTP/2",
            headers: [],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: spec.requestBodySize ?? -1,
            postData: spec.postMimeType ? { mimeType: spec.postMimeType, text: "{}" } : undefined,
        },
        response: {
            status: spec.status,
            statusText: spec.statusText ?? "",
            httpVersion: "HTTP/2",
            headers: [],
            cookies: [],
            content: { size: spec.contentSize ?? 0, mimeType: spec.mimeType ?? "" },
            redirectURL: spec.redirectURL ?? "",
            headersSize: -1,
            bodySize: spec.responseBodySize ?? -1,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
    };
}

/**
 * Six requests: three to the api host, two to www, and one whose url does not parse.
 * The numbers the tests expect are derived from this table.
 */
function harFixture(): HarFile {
    return {
        log: {
            version: "1.2",
            creator: { name: "fixture", version: "1" },
            entries: [
                harEntry({
                    url: "https://api.example.test/v1/items?limit=5",
                    status: 200,
                    statusText: "OK",
                    mimeType: "application/json",
                    contentSize: 1200,
                    responseBodySize: 800,
                    timeMs: 120,
                    startedSecond: 0,
                }),
                harEntry({
                    method: "POST",
                    url: "https://api.example.test/v1/items",
                    status: 201,
                    statusText: "Created",
                    mimeType: "application/json",
                    contentSize: 300,
                    requestBodySize: 50,
                    responseBodySize: 300,
                    postMimeType: "application/json",
                    timeMs: 80,
                    startedSecond: 1,
                }),
                harEntry({
                    url: "https://www.example.test/old",
                    status: 301,
                    mimeType: "text/html",
                    redirectURL: "https://www.example.test/new",
                    timeMs: 15,
                    startedSecond: 2,
                }),
                harEntry({
                    url: "https://www.example.test/missing",
                    status: 404,
                    statusText: "Not Found",
                    mimeType: "text/html",
                    contentSize: 10,
                    responseBodySize: 10,
                    timeMs: 40,
                    startedSecond: 3,
                }),
                harEntry({
                    url: "https://api.example.test/v1/boom",
                    status: 500,
                    statusText: "Server Error",
                    responseBodySize: 0,
                    timeMs: 900,
                    startedSecond: 4,
                }),
                harEntry({
                    url: "not a url",
                    status: 0,
                    mimeType: "application/octet-stream",
                    contentSize: 5,
                    timeMs: 0,
                    startedSecond: 5,
                }),
            ],
        },
    };
}

let scratch: string;
let envSnapshot: ReturnType<typeof env.testing.snapshot>;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "har-core-"));
    envSnapshot = env.testing.snapshot();
    env.testing.set("GENESIS_TOOLS_HOME", join(scratch, "tools-home"));
});

afterEach(() => {
    env.testing.restore(envSnapshot);
    rmSync(scratch, { recursive: true, force: true });
});

function writeHar(har: HarFile, name = "capture.har"): string {
    const path = join(scratch, name);
    writeFileSync(path, SafeJSON.stringify(har, { strict: true }));

    return path;
}

describe("parseHarFile", () => {
    test("indexes every entry with its host, path, status flags and clamped sizes", async () => {
        const path = writeHar(harFixture());

        const { session } = await parseHarFile(path);

        expect(session.entries[0]).toEqual({
            index: 0,
            method: "GET",
            url: "https://api.example.test/v1/items?limit=5",
            domain: "api.example.test",
            path: "/v1/items?limit=5",
            status: 200,
            statusText: "OK",
            mimeType: "application/json",
            requestSize: 0,
            responseSize: 1200,
            timeMs: 120,
            startedDateTime: "2026-10-05T08:00:00.000Z",
            requestBodySize: 0,
            responseBodySize: 800,
            requestBodyMimeType: "",
            hasRequestBody: false,
            hasResponseBody: true,
            isError: false,
            isRedirect: false,
            redirectURL: "",
        });
        expect(session.entries[1]).toMatchObject({
            method: "POST",
            requestSize: 50,
            requestBodySize: 50,
            requestBodyMimeType: "application/json",
            hasRequestBody: true,
        });
        expect(session.entries[2]).toMatchObject({
            isRedirect: true,
            isError: false,
            redirectURL: "https://www.example.test/new",
            responseBodySize: 0,
            hasResponseBody: false,
        });
        expect(session.entries.slice(3, 5).map((entry) => [entry.status, entry.isError, entry.isRedirect])).toEqual([
            [404, true, false],
            [500, true, false],
        ]);
    });

    test("a url that does not parse lands on the unknown host and keeps the raw text as its path", async () => {
        const { session } = await parseHarFile(writeHar(harFixture()));

        expect(session.entries[5]).toMatchObject({ domain: "unknown", path: "not a url", status: 0, isError: false });
    });

    test("stats count statuses by hundred, hosts, content types, bytes, time and errors", async () => {
        const { session } = await parseHarFile(writeHar(harFixture()));

        expect(session.stats).toEqual({
            entryCount: 6,
            domains: { "api.example.test": 3, "www.example.test": 2, unknown: 1 },
            statusDistribution: { "2xx": 2, "3xx": 1, "4xx": 1, "5xx": 1, "0xx": 1 },
            totalSizeBytes: 1515,
            totalTimeMs: 1155,
            errorCount: 2,
            mimeTypeDistribution: {
                "application/json": 2,
                "text/html": 2,
                unknown: 1,
                "application/octet-stream": 1,
            },
            startTime: "2026-10-05T08:00:00.000Z",
            endTime: "2026-10-05T08:00:05.000Z",
        });
    });

    test("the host index lists entry positions per host", async () => {
        const { session } = await parseHarFile(writeHar(harFixture()));

        expect(session.domains).toEqual({ "api.example.test": [0, 1, 4], "www.example.test": [2, 3], unknown: [5] });
    });

    test("the session names its absolute source file and a content hash that follows the bytes", async () => {
        const path = writeHar(harFixture());
        const changed = harFixture();
        changed.log.entries[0].time = 121;
        const otherPath = writeHar(changed, "changed.har");

        const first = await parseHarFile(path);
        const again = await parseHarFile(path);
        const other = await parseHarFile(otherPath);

        expect(first.session.version).toBe(1);
        expect(first.session.sourceFile).toBe(path);
        expect(first.session.createdAt).toBe(first.session.lastAccessedAt);
        expect(first.sourceHash).toBe(first.session.sourceHash);
        expect(again.sourceHash).toBe(first.sourceHash);
        expect(other.sourceHash).not.toBe(first.sourceHash);
    });

    test("a capture with no requests has empty stats and no time range", async () => {
        const empty = harFixture();
        empty.log.entries = [];

        const { session } = await parseHarFile(writeHar(empty));

        expect(session.stats).toMatchObject({ entryCount: 0, startTime: "", endTime: "", errorCount: 0 });
        expect(session.entries).toEqual([]);
        expect(session.domains).toEqual({});
    });

    test("loadHarFile returns the raw HAR document", async () => {
        const har = await loadHarFile(writeHar(harFixture()));

        expect(har.log.entries).toHaveLength(6);
        expect(har.log.creator.name).toBe("fixture");
    });
});

describe("query engine", () => {
    async function entries() {
        return (await parseHarFile(writeHar(harFixture()))).session.entries;
    }

    test("parseEntryIndex reads e-prefixed and bare numbers and rejects anything else", () => {
        expect(parseEntryIndex("e14")).toBe(14);
        expect(parseEntryIndex("14")).toBe(14);
        expect(parseEntryIndex("e0")).toBe(0);
        expect(() => parseEntryIndex("entry")).toThrow(
            'Invalid entry reference: "entry". Use format like "e14" or "14".'
        );
        expect(() => parseEntryIndex("e")).toThrow("Invalid entry reference");
    });

    test("matchStatus takes exact codes, hundreds ranges in either case, and comma lists", () => {
        expect(matchStatus(404, "404")).toBe(true);
        expect(matchStatus(404, "200")).toBe(false);
        expect(matchStatus(404, "4xx")).toBe(true);
        expect(matchStatus(404, "4XX")).toBe(true);
        expect(matchStatus(503, "4xx")).toBe(false);
        expect(matchStatus(503, "404, 5xx")).toBe(true);
        expect(matchStatus(200, "404,5xx")).toBe(false);
    });

    test("matchStatus negations exclude, and a list of only negations passes everything else", () => {
        expect(matchStatus(200, "!200")).toBe(false);
        expect(matchStatus(201, "!200")).toBe(true);
        expect(matchStatus(404, "!4xx")).toBe(false);
        expect(matchStatus(200, "!4xx,!5xx")).toBe(true);
        expect(matchStatus(500, "!4xx,!5xx")).toBe(false);
        expect(matchStatus(404, "!404,4xx")).toBe(false);
        expect(matchStatus(403, "!404,4xx")).toBe(true);
        expect(matchStatus(404, "4xx,!404")).toBe(false);
        expect(matchStatus(403, "4xx,!404")).toBe(true);
        expect(matchStatus(404, "404,5xx,!404")).toBe(false);
    });

    test("filterEntries narrows by host glob, url glob, method list and content type glob", async () => {
        const all = await entries();
        const ids = (filter: Parameters<typeof filterEntries>[1]) => filterEntries(all, filter).map((e) => e.index);

        expect(ids({ domain: "api.example.test" })).toEqual([0, 1, 4]);
        expect(ids({ domain: "*.example.test" })).toEqual([0, 1, 2, 3, 4]);
        expect(ids({ url: "*/v1/*" })).toEqual([0, 1, 4]);
        expect(ids({ method: "post" })).toEqual([1]);
        expect(ids({ method: "get, post" })).toEqual([0, 1, 2, 3, 4, 5]);
        expect(ids({ type: "application/*" })).toEqual([0, 1, 5]);
    });

    test("filterEntries narrows by status, minimum time and minimum size", async () => {
        const all = await entries();
        const ids = (filter: Parameters<typeof filterEntries>[1]) => filterEntries(all, filter).map((e) => e.index);

        expect(ids({ status: "4xx,5xx" })).toEqual([3, 4]);
        expect(ids({ status: "!2xx" })).toEqual([2, 3, 4, 5]);
        expect(ids({ minTime: 100 })).toEqual([0, 4]);
        expect(ids({ minSize: 300 })).toEqual([0, 1]);
    });

    test("filters combine, and the limit applies last", async () => {
        const all = await entries();

        expect(filterEntries(all, { domain: "api.example.test", status: "2xx", limit: 1 }).map((e) => e.index)).toEqual(
            [0]
        );
        expect(filterEntries(all, { limit: 2 }).map((e) => e.index)).toEqual([0, 1]);
        expect(filterEntries(all, {})).toBe(all);
        expect(filterEntries(all, { domain: "nobody.example" })).toEqual([]);
    });

    test("getEntriesForDomain returns that host's entries and ignores stale positions", async () => {
        const { session } = await parseHarFile(writeHar(harFixture()));
        const stale: HarSession = { ...session, domains: { ...session.domains, "api.example.test": [0, 99, -1, 4] } };

        expect(getEntriesForDomain(session, "www.example.test").map((e) => e.index)).toEqual([2, 3]);
        expect(getEntriesForDomain(stale, "api.example.test").map((e) => e.index)).toEqual([0, 4]);
        expect(getEntriesForDomain(session, "nobody.example")).toEqual([]);
    });

    test("groupByDomain keeps entry order inside each host", async () => {
        const groups = groupByDomain(await entries());

        expect([...groups.keys()]).toEqual(["api.example.test", "www.example.test", "unknown"]);
        expect(groups.get("api.example.test")?.map((e) => e.index)).toEqual([0, 1, 4]);
    });
});

describe("isInterestingMimeType", () => {
    test("text and data types show bodies, binary and assets do not, parameters and case are ignored", () => {
        expect(isInterestingMimeType("application/json")).toBe(true);
        expect(isInterestingMimeType("Application/JSON; charset=utf-8")).toBe(true);
        expect(isInterestingMimeType("text/html")).toBe(true);
        expect(isInterestingMimeType("application/x-www-form-urlencoded")).toBe(true);
        expect(isInterestingMimeType("image/png")).toBe(false);
        expect(isInterestingMimeType("text/css")).toBe(false);
        expect(isInterestingMimeType("")).toBe(false);
    });
});

describe("formatter", () => {
    test("truncatePath keeps short paths and ends long ones with three dots at the limit", () => {
        expect(truncatePath("/short", 10)).toBe("/short");
        expect(truncatePath("/a/very/long/path", 10)).toBe("/a/very...");
        expect(truncatePath("1234567890", 10)).toBe("1234567890");
    });

    test("formatPercent rounds and survives an empty total", () => {
        expect(formatPercent(1, 3)).toBe("(33%)");
        expect(formatPercent(2, 3)).toBe("(67%)");
        expect(formatPercent(0, 0)).toBe("(0%)");
    });

    test("formatEntryLine pads the columns of one request", async () => {
        const { session } = await parseHarFile(writeHar(harFixture()));

        expect(formatEntryLine(session.entries[1])).toBe(
            `e1  POST    ${"/v1/items".padEnd(40)}  201     300 B      80ms`
        );
        expect(formatEntryLine(session.entries[0])).toBe(
            `e0  GET     ${"/v1/items?limit=5".padEnd(40)}  200    1.2 KB     120ms`
        );
    });

    test("formatDashboard summarises counts, errors, hosts and content types", async () => {
        const { session } = await parseHarFile(writeHar(harFixture()));

        const text = formatDashboard(session.stats, "/captures/shop.har");
        const lines = text.split("\n");

        expect(lines.slice(0, 5)).toEqual([
            "Source: /captures/shop.har",
            "Entries: 6",
            "Total Duration: 1.2s",
            "Total Size: 1.5 KB",
            "Time Range: 2026-10-05T08:00:00.000Z - 2026-10-05T08:00:05.000Z",
        ]);
        expect(lines).toContain("  2xx: 2 (33%)");
        expect(lines).toContain("  5xx: 1 (17%)");
        expect(lines).toContain("Errors: 2 (client: 1, server: 1)");
        expect(lines.indexOf("Top Domains:")).toBeGreaterThan(lines.indexOf("Errors: 2 (client: 1, server: 1)"));
        expect(text.indexOf("api.example.test")).toBeLessThan(text.indexOf("www.example.test"));
        expect(text.indexOf("www.example.test")).toBeLessThan(text.indexOf("unknown"));
        expect(text).toContain("application/json");
    });

    test("formatDashboard leaves out the time range and the table rows of an empty capture", async () => {
        const empty = harFixture();
        empty.log.entries = [];
        const { session } = await parseHarFile(writeHar(empty));

        const text = formatDashboard(session.stats, "/captures/empty.har");

        expect(text).not.toContain("Time Range");
        expect(text).toContain("Entries: 0");
        expect(text).toContain("Errors: 0 (client: 0, server: 0)");
        expect(text).toContain("Top Domains:");
        expect(text).not.toContain("Count");
    });

    describe("printFormatted", () => {
        let written = "";
        let writeSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            written = "";
            writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
                written += String(chunk);
                return true;
            });
        });

        afterEach(() => {
            writeSpy.mockRestore();
        });

        test("md prints the text as it is", async () => {
            await printFormatted("## heading", "md");

            expect(written).toBe("## heading\n");
        });

        test("json wraps the text in an output field", async () => {
            await printFormatted('say "hi"', "json");

            expect(SafeJSON.parse(written, { strict: true })).toEqual({ output: 'say "hi"' });
        });

        test("toon encodes the same wrapper in the TOON format", async () => {
            await printFormatted("hello", "toon");

            expect(written).toBe("output: hello\n");
        });
    });
});

describe("RefStoreManager", () => {
    const long = "x".repeat(300);

    test("exposes the session hash it was created for", () => {
        expect(new RefStoreManager("abc123").sessionHash).toBe("abc123");
    });

    test("shows a long value in full the first time and as a short reference afterwards", async () => {
        const refs = new RefStoreManager("abc123");

        const first = await refs.formatValue(long, "body-1");
        const second = await refs.formatValue(long, "body-1");

        expect(first).toBe(`[ref:body-1] ${long}`);
        expect(second).toBe(`[ref:body-1] ${"x".repeat(80)}... (300 chars)`);
    });

    test("short values and --full requests never create a reference", async () => {
        const refs = new RefStoreManager("abc123");

        expect(await refs.formatValue("tiny", "body-2")).toBe("tiny");
        expect(await refs.formatValue(long, "body-3", { full: true })).toBe(long);
        expect(await refs.getRef("body-2")).toBeNull();
        expect(await refs.getRef("body-3")).toBeNull();
    });

    test("a reference survives into a new manager for the same session and expands to its preview", async () => {
        await new RefStoreManager("abc123").formatValue(long, "body-4");

        const later = new RefStoreManager("abc123");

        expect(await later.getRef("body-4")).toEqual({ preview: `${"x".repeat(80)}...`, size: 300, shown: true });
        expect(await later.expand("body-4")).toEqual({
            found: true,
            refId: "body-4",
            preview: `${"x".repeat(80)}...`,
            size: 300,
        });
        expect(await later.expand("missing")).toBeNull();
        expect(await new RefStoreManager("other-session").getRef("body-4")).toBeNull();
    });
});

describe("SessionManager", () => {
    test("createSession stores the parsed session and remembers it as the last one", async () => {
        const manager = new SessionManager();
        const path = writeHar(harFixture());

        const session = await manager.createSession(path);

        expect(session.stats.entryCount).toBe(6);
        expect(await manager.getLastSessionHash()).toBe(session.sourceHash);
        expect(manager.getSourceHash(session)).toBe(session.sourceHash);
        expect((await manager.loadSession())?.sourceFile).toBe(path);
    });

    test("loadSession finds a session by its hash or by the capture file's path", async () => {
        const manager = new SessionManager();
        const path = writeHar(harFixture());
        const session = await manager.createSession(path);

        const byHash = await manager.loadSession(session.sourceHash);
        const byPath = await manager.loadSession(path);

        expect(byHash?.sourceHash).toBe(session.sourceHash);
        expect(byPath?.sourceHash).toBe(session.sourceHash);
        expect(byPath?.entries).toHaveLength(6);
    });

    test("loadSession answers null for no last session, an unknown hash and a missing file", async () => {
        const manager = new SessionManager();

        expect(await manager.getLastSessionHash()).toBeNull();
        expect(await manager.loadSession()).toBeNull();
        expect(await manager.loadSession("deadbeefdeadbeef")).toBeNull();
        expect(await manager.loadSession(join(scratch, "nope.har"))).toBeNull();
    });

    test("a capture file that was never loaded has no session even though the file exists", async () => {
        const manager = new SessionManager();
        const path = writeHar(harFixture());

        expect(await manager.loadSession(path)).toBeNull();
    });

    test("loading a session moves its last-accessed time forward", async () => {
        const manager = new SessionManager();
        const session = await manager.createSession(writeHar(harFixture()));
        const stale: HarSession = { ...session, lastAccessedAt: 1_000 };
        await new Storage("har-analyzer").putCacheFile(`sessions/${session.sourceHash}.json`, stale, "1 day");

        const loaded = await manager.loadSession(session.sourceHash);

        expect(loaded?.lastAccessedAt).toBeGreaterThan(1_000);
        expect((await manager.loadSession(session.sourceHash))?.lastAccessedAt).toBeGreaterThanOrEqual(
            loaded?.lastAccessedAt ?? Number.POSITIVE_INFINITY
        );
    });

    test("listSessions reports each stored session and skips the reference files", async () => {
        const manager = new SessionManager();
        const first = await manager.createSession(writeHar(harFixture()));
        const other = harFixture();
        other.log.entries = other.log.entries.slice(0, 2);
        const second = await manager.createSession(writeHar(other, "small.har"));
        await new RefStoreManager(first.sourceHash).formatValue("y".repeat(300), "body-1");

        const listed = await manager.listSessions();

        expect(listed.map((entry) => [entry.hash, entry.entryCount]).sort()).toEqual(
            [
                [first.sourceHash, 6],
                [second.sourceHash, 2],
            ].sort()
        );
        expect(listed.every((entry) => entry.sourceFile.endsWith(".har"))).toBe(true);
    });

    test("cleanExpiredSessions removes sessions idle longer than the limit together with their references", async () => {
        const manager = new SessionManager();
        const storage = new Storage("har-analyzer");
        const idle = await manager.createSession(writeHar(harFixture()));
        const other = harFixture();
        other.log.entries = other.log.entries.slice(0, 2);
        const fresh = await manager.createSession(writeHar(other, "small.har"));
        await new RefStoreManager(idle.sourceHash).formatValue("z".repeat(300), "body-1");
        await storage.putCacheFile(
            `sessions/${idle.sourceHash}.json`,
            { ...idle, lastAccessedAt: Date.now() - 3 * 86_400_000 },
            "1 day"
        );

        const removed = await manager.cleanExpiredSessions();

        expect(removed).toBe(1);
        expect(await manager.loadSession(idle.sourceHash)).toBeNull();
        expect(existsSync(join(storage.getCacheDir(), `sessions/${idle.sourceHash}.refs.json`))).toBe(false);
        expect(await new RefStoreManager(idle.sourceHash).getRef("body-1")).toBeNull();
        expect((await manager.loadSession(fresh.sourceHash))?.entries).toHaveLength(2);
    });

    test("a custom age limit decides what counts as idle", async () => {
        const manager = new SessionManager();
        const session = await manager.createSession(writeHar(harFixture()));
        await new Storage("har-analyzer").putCacheFile(
            `sessions/${session.sourceHash}.json`,
            { ...session, lastAccessedAt: Date.now() - 5_000 },
            "1 day"
        );

        expect(await manager.cleanExpiredSessions(60_000)).toBe(0);
        expect(await manager.cleanExpiredSessions(1_000)).toBe(1);
    });

    test("requireSession returns a stored session", async () => {
        const manager = new SessionManager();
        const session = await manager.createSession(writeHar(harFixture()));

        expect((await manager.requireSession(session.sourceHash)).sourceHash).toBe(session.sourceHash);
        expect((await manager.requireSession()).sourceHash).toBe(session.sourceHash);
    });

    test("requireSession reports a missing session and exits with code 1", async () => {
        const manager = new SessionManager();
        let stderr = "";
        const exit = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
            throw new Error(`exit:${code}`);
        });
        const errSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            stderr += String(chunk);
            return true;
        });

        try {
            await expect(manager.requireSession("nothing-stored")).rejects.toThrow("exit:1");
            expect(exit).toHaveBeenCalledWith(1);
            expect(stderr).toContain("No session loaded. Use `load <file>` first.");
        } finally {
            exit.mockRestore();
            errSpy.mockRestore();
        }
    });
});
