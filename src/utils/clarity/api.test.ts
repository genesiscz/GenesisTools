import { afterAll, describe, expect, test } from "bun:test";
import { ClarityApi } from "@genesiscz/utils/clarity";
import { SafeJSON } from "@genesiscz/utils/json";

// Invented tasks: 130 matches, served 25 at a time unless the request asks for a larger page.
const TASKS = Array.from({ length: 130 }, (_, index) => ({
    _internalId: 1000 + index,
    code: `T${index}`,
    name: `D_410001_Sample_${index}`,
}));
const seen: string[] = [];
const server = Bun.serve({
    port: 0,
    fetch(request) {
        const url = new URL(request.url);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);

        // A filter naming NO_TOTAL gets pages without `_totalCount`, as some Clarity releases send.
        const withTotal = !(url.searchParams.get("filter") ?? "").includes("NO_TOTAL");

        seen.push(`${offset}:${limit}`);

        return new Response(
            SafeJSON.stringify({
                ...(withTotal ? { _totalCount: TASKS.length } : {}),
                _results: TASKS.slice(offset, offset + limit),
            })
        );
    },
});

afterAll(() => {
    server.stop(true);
});

describe("ClarityApi.searchTasks", () => {
    test("reads every page, even when the server caps the page below the one asked for", async () => {
        const api = new ClarityApi({ baseUrl: `http://localhost:${server.port}`, authToken: "t", sessionId: "s" });
        const found = await api.searchTasks("D_410001_");

        expect(found).toHaveLength(130);
        expect(found.at(-1)).toEqual({ taskId: 1129, code: "T129", name: "D_410001_Sample_129" });
        expect(seen).toEqual(["0:50", "50:50", "100:50"]);
    });

    test("without _totalCount a short page is not the end; only an empty page is", async () => {
        const api = new ClarityApi({ baseUrl: `http://localhost:${server.port}`, authToken: "t", sessionId: "s" });

        seen.length = 0;

        const found = await api.searchTasks("NO_TOTAL");

        expect(found).toHaveLength(130);
        expect(seen).toEqual(["0:50", "50:50", "100:50", "130:50"]);
    });
});
