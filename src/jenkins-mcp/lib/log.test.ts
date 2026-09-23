import { describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    it("strips ANSI-concealed Jenkins HashAnchored action IDs (ESC[8mha:...ESC[0m)", () => {
        const input = `Started by upstream project "\x1b[8mha:////4Mp5CAuXu5Tk/kDm+5j8Xzl+BX5cMGKDLQ5zKFXwbr5qAAAAwB+LCAAAAAAAAP9b85aBtbiI\x1b[0mparent-job" build`;
        expect(stripJenkinsHtml(input)).toBe('Started by upstream project "parent-job" build');
    });

    it("strips multiple ANSI conceal blocks on one line", () => {
        const input = `a \x1b[8mha:////ABC\x1b[0m b \x1b[8mha:////DEF\x1b[0m c`;
        expect(stripJenkinsHtml(input)).toBe("a  b  c");
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

    it("returns a complete cached node log on a final build without refetching", async () => {
        await mkdir(TMP, { recursive: true });
        await mkdir(OFFSET_DIR, { recursive: true });
        const path = join(TMP, "cache-fetch-42-node9.log");
        const marker = getJenkinsMcpStorage().getCompleteMarkerPath(path);
        const body = "cached line 1\ncached line 2\n";
        await writeFile(path, body, "utf8");
        await writeFile(marker, "2026-01-01T00:00:00.000Z", "utf8");

        const tracker = { calls: [] as string[] };
        const client = clientWith(tracker, false, "FAILURE");

        const result = await fetchLog(client, "job/cache-fetch", "42", { nodeId: "9" });

        expect(result.content).toBe(body);
        expect(result.lineCount).toBe(2);
        expect(tracker.calls).toHaveLength(1);
        expect(tracker.calls[0]).toContain("/api/json");

        await rm(path);
        await rm(marker);
    });

    it("refetches a node log saved while the build ran, then marks the new copy complete", async () => {
        await mkdir(TMP, { recursive: true });
        const path = join(TMP, "cache-partial-44-node9.log");
        const marker = getJenkinsMcpStorage().getCompleteMarkerPath(path);
        await writeFile(path, "partial\n", "utf8");
        await rm(marker, { force: true });

        const calls: string[] = [];
        const client = {
            get: async (url: string) => {
                calls.push(url);

                if (url.endsWith("/api/json")) {
                    return { status: 200, data: { building: false, result: "SUCCESS" } };
                }

                if (url.includes("consoleFull")) {
                    return { status: 200, data: `<pre class="console-output">partial%0Afinished</pre>` };
                }

                return { status: 200, data: { status: "SUCCESS" } };
            },
        } as unknown as import("axios").AxiosInstance;

        const result = await fetchLog(client, "job/cache-partial", "44", { nodeId: "9" });

        expect(result.content).toBe("partial\nfinished");
        expect(calls.some((url) => url.includes("consoleFull"))).toBe(true);
        expect(await readFile(marker, "utf8")).not.toBe("");

        await rm(path);
        await rm(marker);
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

describe("fetchLog (whole-build)", () => {
    const TMP = LOG_DIR;

    function consoleTextClient({ building, body }: { building: boolean; body: string }) {
        const calls: string[] = [];
        const client = {
            get: async (url: string) => {
                calls.push(url);

                if (url.endsWith("/api/json")) {
                    return { status: 200, data: { building, result: building ? null : "SUCCESS" } };
                }

                if (url.endsWith("/consoleText")) {
                    return { status: 200, data: body };
                }

                throw new Error(`unexpected fetch: ${url}`);
            },
        } as unknown as import("axios").AxiosInstance;

        return { client, calls };
    }

    async function cleanup(file: string) {
        await rm(file, { force: true });
        await rm(getJenkinsMcpStorage().getCompleteMarkerPath(file), { force: true });
    }

    it("fetches /consoleText, strips it, and marks the copy complete on a final build", async () => {
        await mkdir(TMP, { recursive: true });
        const file = join(TMP, "whole-test-1.log");
        await cleanup(file);

        const delta = `<span class="timestamp"><b>10:00:00</b> </span><span style="display: none">[2026-05-12T10:00:00.000Z]</span>hello\nline2\n`;
        const { client, calls } = consoleTextClient({ building: false, body: delta });
        const result = await fetchLog(client, "job/whole-test", "1");

        expect(result.content).toBe("hello\nline2\n");
        expect(result.lineCount).toBe(2);
        expect(calls.some((url) => url.endsWith("/consoleText"))).toBe(true);
        expect(await readFile(getJenkinsMcpStorage().getCompleteMarkerPath(file), "utf8")).not.toBe("");

        await cleanup(file);
    });

    it("reuses a complete copy on a final build without fetching the log again", async () => {
        await mkdir(TMP, { recursive: true });
        await mkdir(OFFSET_DIR, { recursive: true });
        const file = join(TMP, "whole-test-2.log");
        await writeFile(file, "done\n", "utf8");
        await writeFile(getJenkinsMcpStorage().getCompleteMarkerPath(file), "2026-01-01T00:00:00.000Z", "utf8");

        const { client, calls } = consoleTextClient({ building: false, body: "unexpected\n" });
        const result = await fetchLog(client, "job/whole-test", "2");

        expect(result.content).toBe("done\n");
        expect(calls).toHaveLength(1);

        await cleanup(file);
    });

    it("refetches a copy saved while the build ran, now that the build is final", async () => {
        await mkdir(TMP, { recursive: true });
        const file = join(TMP, "whole-test-3.log");
        await cleanup(file);
        await writeFile(file, "partial\n", "utf8");

        const { client } = consoleTextClient({ building: false, body: "partial\nrest\n" });
        const result = await fetchLog(client, "job/whole-test", "3");

        expect(result.content).toBe("partial\nrest\n");

        await cleanup(file);
    });

    it("leaves no complete marker while the build still runs", async () => {
        await mkdir(TMP, { recursive: true });
        const file = join(TMP, "whole-test-4.log");
        await cleanup(file);

        const { client } = consoleTextClient({ building: true, body: "so far\n" });
        await fetchLog(client, "job/whole-test", "4");

        expect(await Bun.file(getJenkinsMcpStorage().getCompleteMarkerPath(file)).exists()).toBe(false);

        await cleanup(file);
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
