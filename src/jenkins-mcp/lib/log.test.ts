import { describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fetchLog, grepLog, isBuildFinal, parseConsoleFullHtml, readCachedLog, stripJenkinsHtml } from "./log";
import { getJenkinsMcpStorage } from "./storage";

const LOG_DIR = join(tmpdir(), "jenkins-mcp");
const OFFSET_DIR = getJenkinsMcpStorage().getCacheDir();

describe("stripJenkinsHtml", () => {
    it("removes timestamp spans (b + hidden ISO)", () => {
        const input =
            '<span class="timestamp"><b>19:33:34</b> </span><span style="display: none">[2026-05-11T17:33:34.157Z]</span> + foo@1.0.0';
        expect(stripJenkinsHtml(input)).toBe(" + foo@1.0.0");
    });

    it("preserves text without spans", () => {
        expect(stripJenkinsHtml("plain text")).toBe("plain text");
    });

    it("handles multiline logs", () => {
        const input = `<span class="timestamp"><b>19:33:34</b> </span><span style="display: none">[2026-05-11T17:33:34.157Z]</span>a
<span class="timestamp"><b>19:33:35</b> </span><span style="display: none">[2026-05-11T17:33:35.000Z]</span>b`;
        expect(stripJenkinsHtml(input)).toBe("a\nb");
    });

    it("strips any leftover span tags after the main pattern", () => {
        const input = "<span>foo</span> bar";
        expect(stripJenkinsHtml(input)).toBe("foo bar");
    });

    it("strips <a href='...'> link decorations Jenkins adds to URLs", () => {
        const input = "WARN  GET <a href='https://example.com/pkg.tgz'>https://example.com/pkg.tgz</a> error";
        expect(stripJenkinsHtml(input)).toBe("WARN  GET https://example.com/pkg.tgz error");
    });

    it("strips other simple decoration tags (b, i, code, etc.) keeping inner text", () => {
        const input = "<b>bold</b> and <code>inline-code</code> and <em>emph</em>";
        expect(stripJenkinsHtml(input)).toBe("bold and inline-code and emph");
    });
});

describe("grepLog", () => {
    it("returns matches formatted as 'L<n>: <text>'", () => {
        const content = "alpha\nbravo MATCH\ncharlie\ndelta MATCH";
        expect(grepLog(content, "MATCH")).toEqual(["L2: bravo MATCH", "L4: delta MATCH"]);
    });

    it("trims trailing \\r from matched lines (Jenkins CRLF)", () => {
        const content = "alpha MATCH\r\nbravo MATCH\r";
        expect(grepLog(content, "MATCH")).toEqual(["L1: alpha MATCH", "L2: bravo MATCH"]);
    });

    it("caps at 200 matches", () => {
        const content = Array.from({ length: 500 }, (_, i) => `hit ${i}`).join("\n");
        expect(grepLog(content, "hit").length).toBe(200);
    });

    it("resets lastIndex so /g patterns don't skip", () => {
        const content = "alpha bravo\ncharlie bravo\ndelta bravo";
        const matches = grepLog(content, "(?:^|\\W)bravo(?:\\W|$)");
        expect(matches.length).toBe(3);
    });

    it("returns empty array when no matches", () => {
        expect(grepLog("alpha\nbravo", "nothere")).toEqual([]);
    });
});

describe("isBuildFinal", () => {
    function mockClient(response: { status: number; data?: unknown }) {
        return { get: async () => response } as unknown as import("axios").AxiosInstance;
    }

    it("returns true when building=false and result is non-null", async () => {
        const client = mockClient({ status: 200, data: { building: false, result: "FAILURE" } });
        expect(await isBuildFinal(client, "job/foo", "42")).toBe(true);
    });

    it("returns false when building=true", async () => {
        const client = mockClient({ status: 200, data: { building: true, result: null } });
        expect(await isBuildFinal(client, "job/foo", "42")).toBe(false);
    });

    it("returns false when result is null (queued/in-flight)", async () => {
        const client = mockClient({ status: 200, data: { building: false, result: null } });
        expect(await isBuildFinal(client, "job/foo", "42")).toBe(false);
    });

    it("returns false on 404 (pruned/absent — let fetchLog re-confirm with its own error)", async () => {
        const client = mockClient({ status: 404 });
        expect(await isBuildFinal(client, "job/foo", "42")).toBe(false);
    });
});

describe("readCachedLog", () => {
    const TMP = LOG_DIR;

    it("returns null when the file is absent", async () => {
        const result = await readCachedLog("job/nonexistent-xyz", "99999", "1");
        expect(result).toBeNull();
    });

    it("returns LogResult with content, sizeBytes, lineCount when file exists", async () => {
        await mkdir(TMP, { recursive: true });
        const path = join(TMP, "cache-test-1-node5.log");
        const body = "alpha\nbravo\ncharlie\n";
        await writeFile(path, body, "utf8");

        const result = await readCachedLog("job/cache-test", "1", "5");
        expect(result).not.toBeNull();
        expect(result?.path).toBe(path);
        expect(result?.content).toBe(body);
        expect(result?.sizeBytes).toBe(Buffer.byteLength(body, "utf8"));
        expect(result?.lineCount).toBe(3);
        expect(result?.truncated).toBe(false);
        expect(result?.nodeStatus).toBeUndefined();

        await rm(path);
    });

    it("computes the path with or without nodeId", async () => {
        await mkdir(TMP, { recursive: true });
        const pathNoNode = join(TMP, "cache-test2-7.log");
        await writeFile(pathNoNode, "x\n", "utf8");

        const result = await readCachedLog("job/cache-test2", "7");
        expect(result?.path).toBe(pathNoNode);

        await rm(pathNoNode);
    });
});

describe("fetchLog (cache path)", () => {
    const TMP = LOG_DIR;

    function clientWith(callTracker: { calls: string[] }, building: boolean, result: string | null) {
        return {
            get: async (url: string) => {
                callTracker.calls.push(url);
                if (url.endsWith("/api/json")) {
                    return { status: 200, data: { building, result } };
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
        } as unknown as import("axios").AxiosInstance;
    }

    it("returns cached log on a final build without paginating wfapi", async () => {
        await mkdir(TMP, { recursive: true });
        const path = join(TMP, "cache-fetch-42-node9.log");
        const body = "cached line 1\ncached line 2\n";
        await writeFile(path, body, "utf8");

        const tracker = { calls: [] as string[] };
        const client = clientWith(tracker, false, "FAILURE");

        const result = await fetchLog(client, "job/cache-fetch", "42", { nodeId: "9" });

        expect(result.content).toBe(body);
        expect(result.lineCount).toBe(2);
        expect(tracker.calls).toHaveLength(1);
        expect(tracker.calls[0]).toContain("/api/json");

        await rm(path);
    });

    it("ignores cache when build is still in progress", async () => {
        await mkdir(TMP, { recursive: true });
        const path = join(TMP, "cache-inflight-43-node9.log");
        await writeFile(path, "stale\n", "utf8");

        const tracker = { calls: [] as string[] };
        const client = clientWith(tracker, true, null);

        await expect(fetchLog(client, "job/cache-inflight", "43", { nodeId: "9" })).rejects.toThrow(/unexpected fetch/);

        await rm(path);
    });

    it("ignores cache when the file does not exist", async () => {
        const tracker = { calls: [] as string[] };
        const client = clientWith(tracker, false, "SUCCESS");

        await expect(fetchLog(client, "job/cache-missing-zzz", "1", { nodeId: "9" })).rejects.toThrow(
            /unexpected fetch/
        );
    });
});

describe("fetchLog (whole-build incremental)", () => {
    const TMP = LOG_DIR;

    function progressiveTextClient(scripted: Array<{ start: number; body: string; xTextSize: number }>) {
        let cursor = 0;
        return {
            get: async (url: string, opts?: { params?: { start?: number; tree?: string } }) => {
                // isBuildFinal probe — return in-progress so the cache-hit shortcut is skipped
                // and the incremental whole-build path is exercised.
                if (url.endsWith("/api/json")) {
                    return { status: 200, data: { building: true, result: null } };
                }
                const start = opts?.params?.start ?? 0;
                const step = scripted[cursor++];
                if (!step) {
                    throw new Error(`progressiveText called more times than scripted (start=${start})`);
                }
                if (step.start !== start) {
                    throw new Error(`expected start=${step.start} got ${start}`);
                }
                return {
                    status: 200,
                    data: step.body,
                    headers: { "x-text-size": String(step.xTextSize) },
                };
            },
        } as unknown as import("axios").AxiosInstance;
    }

    it("first call writes full body and persists offset sidecar", async () => {
        await mkdir(TMP, { recursive: true });
        const file = join(TMP, "incr-test-1.log");
        const offsetFile = join(OFFSET_DIR, `${basename(file)}.offset`);
        await rm(file, { force: true });
        await rm(offsetFile, { force: true });

        const client = progressiveTextClient([{ start: 0, body: "line1\nline2\n", xTextSize: 12 }]);
        const result = await fetchLog(client, "job/incr-test", "1");
        expect(result.content).toBe("line1\nline2\n");
        expect(result.lineCount).toBe(2);

        const offset = await readFile(offsetFile, "utf8");
        expect(offset).toBe("12");

        await rm(file);
        await rm(offsetFile);
    });

    it("second call requests start=priorOffset, appends delta, advances offset", async () => {
        await mkdir(TMP, { recursive: true });
        const file = join(TMP, "incr-test-2.log");
        const offsetFile = join(OFFSET_DIR, `${basename(file)}.offset`);
        await writeFile(file, "line1\nline2\n", "utf8");
        await writeFile(offsetFile, "12", "utf8");

        const client = progressiveTextClient([{ start: 12, body: "line3\n", xTextSize: 18 }]);
        const result = await fetchLog(client, "job/incr-test", "2");
        expect(result.content).toBe("line1\nline2\nline3\n");
        expect(result.lineCount).toBe(3);

        const offset = await readFile(offsetFile, "utf8");
        expect(offset).toBe("18");

        await rm(file);
        await rm(offsetFile);
    });

    it("poll with no new bytes leaves content and offset unchanged", async () => {
        await mkdir(TMP, { recursive: true });
        const file = join(TMP, "incr-test-3.log");
        const offsetFile = join(OFFSET_DIR, `${basename(file)}.offset`);
        await writeFile(file, "settled\n", "utf8");
        await writeFile(offsetFile, "8", "utf8");

        const client = progressiveTextClient([{ start: 8, body: "", xTextSize: 8 }]);
        const result = await fetchLog(client, "job/incr-test", "3");
        expect(result.content).toBe("settled\n");
        expect(result.lineCount).toBe(1);

        await rm(file);
        await rm(offsetFile);
    });

    it("strips Jenkins timestamp spans from each delta", async () => {
        await mkdir(TMP, { recursive: true });
        const file = join(TMP, "incr-test-4.log");
        const offsetFile = join(OFFSET_DIR, `${basename(file)}.offset`);
        await rm(file, { force: true });
        await rm(offsetFile, { force: true });

        const delta = `<span class="timestamp"><b>10:00:00</b> </span><span style="display: none">[2026-05-12T10:00:00.000Z]</span>hello\n`;
        const client = progressiveTextClient([{ start: 0, body: delta, xTextSize: delta.length }]);
        const result = await fetchLog(client, "job/incr-test", "4");
        expect(result.content).toBe("hello\n");

        await rm(file);
        await rm(offsetFile);
    });
});

describe("parseConsoleFullHtml", () => {
    it("extracts the <pre class='console-output'> body, URL-decodes, strips spans, unescapes entities", () => {
        // URL-encoded "Hello <world>" plus a Jenkins timestamp wrapper.
        const html = `<html><body><pre class="console-output"><span class="timestamp"><b>10:00:00</b> </span><span style="display: none">[2026-05-12T10:00:00.000Z]</span>Hello%20%26lt%3Bworld%26gt%3B%0Aline2</pre></body></html>`;
        // After URL-decode: <span...>...</span>Hello &lt;world&gt;\nline2
        // After span strip: Hello &lt;world&gt;\nline2
        // After entity unescape: Hello <world>\nline2
        expect(parseConsoleFullHtml(html)).toBe("Hello <world>\nline2");
    });

    it("throws when the page has no <pre class='console-output'>", () => {
        expect(() => parseConsoleFullHtml("<html><body>error page</body></html>")).toThrow(/missing/);
    });

    it("handles multi-line content with embedded < and > characters in URL-encoded form", () => {
        const html = `<pre class="console-output">at%20Thread.run%28Thread.java%3A1583%29%0AException%3A%20%26lt%3Bunknown%26gt%3B</pre>`;
        expect(parseConsoleFullHtml(html)).toBe("at Thread.run(Thread.java:1583)\nException: <unknown>");
    });
});

describe("grepLog (streaming parity)", () => {
    it("handles input without trailing newline", () => {
        const content = "alpha MATCH\nbravo\ncharlie MATCH";
        expect(grepLog(content, "MATCH")).toEqual(["L1: alpha MATCH", "L3: charlie MATCH"]);
    });

    it("returns line numbers identical to the old split-based impl on a 50k-line input", () => {
        const lines: string[] = [];
        for (let i = 0; i < 50_000; i++) {
            lines.push(i % 1000 === 0 ? `MATCH at ${i}` : `noise ${i}`);
        }
        const content = lines.join("\n");
        const matches = grepLog(content, "MATCH");

        expect(matches).toHaveLength(50);
        expect(matches[0]).toBe("L1: MATCH at 0");
        expect(matches[1]).toBe("L1001: MATCH at 1000");
    });
});
