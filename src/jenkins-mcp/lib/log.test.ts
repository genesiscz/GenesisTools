import { describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchLog, grepLog, isBuildFinal, readCachedLog, stripJenkinsHtml } from "./log";

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
    const TMP = "/tmp/jenkins-mcp";

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
    const TMP = "/tmp/jenkins-mcp";

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

        await expect(fetchLog(client, "job/cache-inflight", "43", { nodeId: "9" })).rejects.toThrow(
            /unexpected fetch/
        );

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
