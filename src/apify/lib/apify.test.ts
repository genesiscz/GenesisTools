import { describe, expect, mock, test } from "bun:test";
import { type ApifyCredentials, login, logout, requireToken, status, validateToken } from "@app/apify/lib/auth";
import {
    ApifyClient,
    ApifyError,
    type ApifyFetch,
    type ApifyRun,
    parseInput,
    runCosts,
    sanitizeResult,
} from "@app/apify/lib/client";
import { type CostRunSource, instant, summarizeCosts } from "@app/apify/lib/costs";
import { ApifyMcp, type ApifyMcpSession } from "@app/apify/lib/mcp";
import { SafeJSON } from "@genesiscz/utils/json";

const TOKEN = "invented-apify-token-for-tests";
const user = { id: "testUser", username: "alice" };

function credentials() {
    return {
        has: mock(() => true),
        get: mock(async () => TOKEN),
        save: mock(async (_token: string) => {}),
        remove: mock(async () => true),
    } satisfies ApifyCredentials;
}

function responder(body: unknown): { fetcher: ApifyFetch; calls: Array<{ url: URL; init: RequestInit }> } {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    return {
        fetcher: async (url, init) => {
            calls.push({ url: new URL(url), init });
            return new Response(SafeJSON.stringify(body), { headers: { "content-type": "application/json" } });
        },
        calls,
    };
}

describe("Apify credentials", () => {
    test("local status cannot decrypt, validate, save or delete a credential", () => {
        const store = credentials();
        const forbidden = () => {
            throw new Error("status attempted a credential side effect");
        };
        store.get.mockImplementation(forbidden);
        store.save.mockImplementation(forbidden);
        store.remove.mockImplementation(forbidden);
        expect(status(store)).toMatchObject({ stored: true, storage: "encrypted-vault" });
        expect(store.has).toHaveBeenCalledTimes(1);
        expect(store.get).not.toHaveBeenCalled();
        expect(store.save).not.toHaveBeenCalled();
        expect(store.remove).not.toHaveBeenCalled();
    });

    test("failed remote validation preserves the old saved token", async () => {
        const store = credentials();
        await expect(
            login({
                token: TOKEN,
                credentials: store,
                validate: async () => {
                    throw new ApifyError("Apify HTTP 401.");
                },
            })
        ).rejects.toThrow("401");
        expect(store.save).not.toHaveBeenCalled();
        expect(store.remove).not.toHaveBeenCalled();
    });

    test("a successful login validates the token before saving exactly that token", async () => {
        const store = credentials();
        const events: string[] = [];
        store.save.mockImplementation(async (token) => {
            events.push(`save:${token}`);
        });
        const result = await login({
            token: ` ${TOKEN}\n`,
            credentials: store,
            validate: async (token) => {
                events.push(`validate:${token}`);
                return user;
            },
        });
        expect(events).toEqual([`validate:${TOKEN}`, `save:${TOKEN}`]);
        expect(result).toEqual({ authenticated: true, user });
        expect(store.get).not.toHaveBeenCalled();
    });

    test("logout deletes only through the owned credential adapter and never reads the key", async () => {
        const store = credentials();
        expect(await logout(store)).toEqual({ removed: true, remotelyRevoked: false });
        expect(store.remove).toHaveBeenCalledTimes(1);
        expect(store.get).not.toHaveBeenCalled();
        expect(store.save).not.toHaveBeenCalled();
    });

    test("absent credentials and malformed tokens fail without revealing input", async () => {
        const absent: ApifyCredentials = { ...credentials(), get: async () => undefined };
        await expect(requireToken(absent)).rejects.toThrow("tools apify login");
        expect(() => validateToken("bad\ntoken")).toThrow("single Apify API token");
        expect(() => validateToken("x".repeat(5000))).toThrow("single Apify API token");
    });
});

describe("Apify transport", () => {
    test("uses bearer auth only in headers, rejects redirects and strips private user fields", async () => {
        const stub = responder({ data: { ...user, token: TOKEN, email: "alice@example.com" } });
        const client = new ApifyClient({ token: TOKEN, fetcher: stub.fetcher });
        expect(await client.me()).toEqual(user);
        expect(stub.calls[0].url.toString()).toBe("https://api.apify.com/v2/users/me");
        expect(stub.calls[0].url.toString()).not.toContain(TOKEN);
        expect(stub.calls[0].init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
        expect(stub.calls[0].init.redirect).toBe("error");
    });

    test("forwards explicit paid limits and normalized Actor ID without an automatic retry", async () => {
        const stub = responder({ data: { id: "runOne", status: "READY", statusMessage: null, exitCode: null } });
        const client = new ApifyClient({ token: TOKEN, fetcher: stub.fetcher });
        const result = await client.start({
            actor: "alice/actor",
            input: { query: "sample" },
            maxCost: 0.15,
            maxItems: 7,
        });
        expect(result).toMatchObject({ id: "runOne", statusMessage: null, exitCode: null });
        const call = stub.calls[0];
        expect(call.url.pathname).toBe("/v2/actors/alice~actor/runs");
        expect(call.url.searchParams.get("maxTotalChargeUsd")).toBe("0.15");
        expect(call.url.searchParams.get("maxItems")).toBe("7");
        expect(call.init.method).toBe("POST");
        expect(SafeJSON.parse(String(call.init.body))).toEqual({ query: "sample" });
        expect(stub.calls).toHaveLength(1);
        await expect(client.start({ actor: "alice/actor", input: {}, maxCost: 0 })).rejects.toThrow("positive USD");
        expect(stub.calls).toHaveLength(1);
    });

    test("request failure is redacted, reports unknown POST outcome and never retries", async () => {
        let calls = 0;
        const client = new ApifyClient({
            token: TOKEN,
            fetcher: async () => {
                calls++;
                throw new Error(`request failed Authorization Bearer ${TOKEN}`);
            },
        });
        let message = "";
        try {
            await client.start({ actor: "alice/actor", input: {}, maxCost: 1 });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("result is unknown");
        expect(message).not.toContain(TOKEN);
        expect(calls).toBe(1);
    });

    test("HTTP error bodies and invalid upstream shapes cannot echo secrets", async () => {
        const denied = new ApifyClient({ token: TOKEN, fetcher: async () => new Response(TOKEN, { status: 403 }) });
        await expect(denied.me()).rejects.toThrow("Apify HTTP 403");
        const bad = responder({ data: { id: TOKEN, username: { token: TOKEN } } });
        await expect(new ApifyClient({ token: TOKEN, fetcher: bad.fetcher }).me()).rejects.toThrow(
            "unexpected response shape"
        );
    });

    test("search, schema, run and dataset paths carry their bounds", async () => {
        const search = responder({
            data: { total: 5, offset: 2, limit: 2, items: [{ id: "actorOne", name: "actor" }] },
        });
        await new ApifyClient({ fetcher: search.fetcher }).search({ query: "reddit research", limit: 2, offset: 2 });
        expect(search.calls[0].url.pathname).toBe("/v2/store");
        expect(search.calls[0].url.searchParams.get("search")).toBe("reddit research");
        expect(search.calls[0].url.searchParams.get("offset")).toBe("2");
        const schema = responder({ data: { actorDefinition: { input: { type: "object", properties: {} } } } });
        expect(await new ApifyClient({ fetcher: schema.fetcher }).schema("alice/actor")).toMatchObject({
            type: "object",
        });
        expect(schema.calls[0].url.pathname).toBe("/v2/actors/alice~actor/builds/default");
        const dataset = responder([{ text: "example", apiKey: "private" }]);
        const items = await new ApifyClient({ fetcher: dataset.fetcher }).items({
            dataset: "datasetOne",
            limit: 3,
            offset: 4,
            fields: "text",
        });
        expect(items.items).toEqual([{ text: "example", apiKey: "private" }]);
        expect(dataset.calls[0].url.pathname).toBe("/v2/datasets/datasetOne/items");
        expect(dataset.calls[0].url.searchParams.get("limit")).toBe("3");
        expect(dataset.calls[0].url.searchParams.get("offset")).toBe("4");
        expect(dataset.calls[0].url.searchParams.get("fields")).toBe("text");
    });

    test("resource traversal and invalid pages fail before HTTP", async () => {
        const stub = responder({ data: {} });
        const client = new ApifyClient({ fetcher: stub.fetcher });
        await expect(client.run("../../users/me")).rejects.toThrow("Resource ID");
        await expect(client.schema("alice/actor/extra")).rejects.toThrow("Actor must");
        await expect(client.runs({ limit: 1001, offset: 0 })).rejects.toThrow("Limit");
        await expect(client.items({ dataset: "one", limit: 1, offset: -1 })).rejects.toThrow("Offset");
        expect(stub.calls).toHaveLength(0);
    });

    test("reads a legacy input schema when the current build definition is null", async () => {
        const stub = responder({ data: { actorDefinition: null, inputSchema: '{"type":"object"}' } });
        expect(await new ApifyClient({ fetcher: stub.fetcher }).schema("alice/actor")).toEqual({ type: "object" });
    });

    test("strict JSON object input and nested exact-token redaction", () => {
        expect(parseInput('{"url":"https://example.com"}')).toEqual({ url: "https://example.com" });
        expect(() => parseInput("[]")).toThrow("JSON object");
        expect(() => parseInput('{"x":1,}')).toThrow("valid JSON");
        expect(sanitizeResult({ note: `before ${TOKEN} after`, nested: [{ password: "secret" }] }, TOKEN)).toEqual({
            note: "before [redacted] after",
            nested: [{ password: "secret" }],
        });
    });
});

const SINCE = "2026-01-01T00:00:00Z";
const UNTIL = "2026-01-02T00:00:00Z";
function run(id: string, cost?: number): ApifyRun {
    return { id, actId: "actorOne", status: "SUCCEEDED", startedAt: "2026-01-01T12:00:00Z", usageTotalUsd: cost };
}

describe("recorded costs", () => {
    test("page subtotals use actual recorded amounts and expose missing costs", () => {
        expect(runCosts([run("one", 0.12), run("two", 0.03), run("three")])).toEqual({
            usageTotalUsd: 0.15,
            runsWithCost: 2,
            runsWithoutCost: 1,
            scope: "returned-page",
        });
    });

    test("time bounds reach every API page and totals include only the requested complete window", async () => {
        const seen: Array<Parameters<CostRunSource["runs"]>[0]> = [];
        const source: CostRunSource = {
            runs: async (options) => {
                seen.push(options);
                return {
                    total: 3,
                    offset: options.offset,
                    count: options.offset === 0 ? 2 : 1,
                    items: options.offset === 0 ? [run("one", 0.12), run("two", 0.03)] : [run("three", 0)],
                };
            },
        };
        const result = await summarizeCosts({ source, since: SINCE, until: UNTIL, pageSize: 2, maxPages: 3 });
        expect(seen.map((page) => page.offset)).toEqual([0, 2]);
        expect(
            seen.every(
                (page) =>
                    page.startedAfter === new Date(SINCE).toISOString() &&
                    page.startedBefore === new Date(UNTIL).toISOString()
            )
        ).toBe(true);
        expect(result.recordedUsageTotalUsd).toBeCloseTo(0.15);
        expect(result.paginationComplete).toBe(true);
        expect(result.costDataComplete).toBe(true);
        expect(result.basis).toContain("before account credits");
    });

    test("a capped window is a subtotal, never a complete total", async () => {
        const source: CostRunSource = { runs: async () => ({ total: 4, offset: 0, items: [run("one", 0.2)] }) };
        const result = await summarizeCosts({ source, since: SINCE, until: UNTIL, pageSize: 1, maxPages: 1 });
        expect(result.recordedUsageTotalUsd).toBe(0.2);
        expect(result.paginationComplete).toBe(false);
        expect(result.costDataComplete).toBe(false);
        expect(result.incompleteReason).toBe("max-pages-reached");
        expect(result.nextOffset).toBe(1);
    });

    test("missing costs and running jobs remain provisional even on a complete page", async () => {
        const source: CostRunSource = {
            runs: async () => ({ total: 2, offset: 0, items: [run("one"), { ...run("two", 0.1), status: "RUNNING" }] }),
        };
        const result = await summarizeCosts({ source, since: SINCE, until: UNTIL, pageSize: 2, maxPages: 1 });
        expect(result.paginationComplete).toBe(true);
        expect(result.costDataComplete).toBe(false);
        expect(result.runsWithoutCost).toBe(1);
        expect(result.unfinishedRuns).toBe(1);
    });

    test("duplicates and a changing result set cannot claim completeness", async () => {
        const source: CostRunSource = {
            runs: async (page) => ({
                total: page.offset === 0 ? 2 : 3,
                offset: page.offset,
                items: [run("same", 0.1)],
            }),
        };
        const result = await summarizeCosts({ source, since: SINCE, until: UNTIL, pageSize: 1, maxPages: 3 });
        expect(result.recordedUsageTotalUsd).toBe(0.1);
        expect(result.paginationComplete).toBe(false);
        expect(result.incompleteReason).toBe("results-changed-during-pagination");
    });

    test("ambiguous timezones and backwards windows are rejected before requests", async () => {
        expect(() => instant("2026-01-01")).toThrow("timezone");
        const source: CostRunSource = {
            runs: async () => {
                throw new Error("must not request");
            },
        };
        await expect(summarizeCosts({ source, since: UNTIL, until: SINCE, pageSize: 1, maxPages: 1 })).rejects.toThrow(
            "Since"
        );
    });
});

describe("hosted MCP parity and spending boundary", () => {
    function session() {
        return {
            callTool: mock(
                async (_params: { name: string; arguments: Record<string, unknown> }): Promise<unknown> => ({
                    structuredContent: { value: TOKEN },
                })
            ),
            listTools: mock(async () => ({
                tools: [{ name: "fetch-actor-details", inputSchema: { type: "object" } }],
            })),
            close: mock(async () => {}),
        } satisfies ApifyMcpSession;
    }

    test("public discovery, rich details and docs need no credentials; preserve tool arguments", async () => {
        const fake = session();
        const urls: URL[] = [];
        const mcp = new ApifyMcp({
            connect: async ({ url, token }) => {
                expect(token).toBeUndefined();
                urls.push(url);
                return fake;
            },
        });
        await mcp.tools();
        for (const tool of ["search-actors", "fetch-actor-details", "search-apify-docs"]) {
            const args = {
                actor: "alice/test",
                output: { serverInterface: "GET /search" },
                docSource: "crawlee-js",
                query: "requests",
            };
            await mcp.invoke({ tool, args });
            expect(fake.callTool).toHaveBeenLastCalledWith({ name: tool, arguments: args });
        }
        await mcp.invoke({ tool: "fetch-apify-docs", args: { url: "https://docs.apify.com/mcp" } });
        expect(
            urls.every(
                (url) => url.origin === "https://mcp.apify.com" && url.searchParams.get("telemetry-enabled") === "false"
            )
        ).toBe(true);
        expect(fake.close).toHaveBeenCalledTimes(5);
    });

    test("storage/run tools authenticate, redact tokens and preserve structured output", async () => {
        const fake = session();
        const mcp = new ApifyMcp({ token: TOKEN, connect: async () => fake });
        for (const tool of ["get-dataset-items", "get-key-value-store-record", "get-actor-run"]) {
            expect(await mcp.invoke({ tool, args: { limit: 2, offset: 1 } })).toEqual({
                structuredContent: { value: "[redacted]" },
            });
        }
        await expect(new ApifyMcp().invoke({ tool: "get-actor-run", args: {} })).rejects.toThrow("login");
    });

    test("Actor MCP calls and discovery require explicit uncapped-cost opt-in before connecting", async () => {
        const fake = session();
        const open = mock(async () => fake);
        const mcp = new ApifyMcp({ token: TOKEN, connect: open });
        for (const tool of ["fetch-actor-mcp-tool-list", "call-actor-mcp-tool"]) {
            await expect(mcp.invoke({ tool, args: { actor: "alice/test", tool: "add" } })).rejects.toThrow(
                "--allow-uncapped-cost"
            );
        }
        expect(open).not.toHaveBeenCalled();
        await mcp.invoke({
            tool: "call-actor-mcp-tool",
            args: { actor: "alice/test", tool: "add", arguments: { a: 1 } },
            allowUncappedCost: true,
        });
        expect(fake.callTool).toHaveBeenCalledTimes(1);
        expect(fake.callTool).toHaveBeenCalledWith({
            name: "call-actor-mcp-tool",
            arguments: { actor: "alice/test", tool: "add", arguments: { a: 1 } },
        });
    });

    test("problem reporting requires an explicit external-message opt-in", async () => {
        const fake = session();
        const open = mock(async (_options: { url: URL; token?: string }) => fake);
        const mcp = new ApifyMcp({ token: TOKEN, connect: open });
        const args = { message: "An example problem" };
        await expect(mcp.invoke({ tool: "report-problem", args })).rejects.toThrow("--allow-report");
        expect(open).not.toHaveBeenCalled();
        await mcp.invoke({ tool: "report-problem", args, allowReport: true });
        expect(open.mock.calls[0][0].url.searchParams.get("telemetry-enabled")).toBe("true");
        expect(fake.callTool).toHaveBeenCalledWith({ name: "report-problem", arguments: args });
    });

    test("unknown tools, traversal and foreign documentation URLs fail before any connection", async () => {
        const open = mock(async () => session());
        const mcp = new ApifyMcp({ token: TOKEN, connect: open });
        for (const tool of ["call-actor", "future-paid-tool"]) {
            await expect(mcp.invoke({ tool, args: {} })).rejects.toThrow("Unsupported");
        }
        await expect(
            mcp.invoke({ tool: "call-actor-mcp-tool", args: { actor: "../test" }, allowUncappedCost: true })
        ).rejects.toThrow("Actor must");
        for (const url of [
            "https://evil.example/test",
            "https://docs.apify.com.evil.example",
            "https://alice:password@docs.apify.com/mcp",
            "http://docs.apify.com/mcp",
        ]) {
            await expect(mcp.invoke({ tool: "fetch-apify-docs", args: { url } })).rejects.toThrow(
                "HTTPS documentation"
            );
        }
        expect(open).not.toHaveBeenCalled();
    });

    test("failures redact server errors, close once and never replay a tool invocation", async () => {
        const fake = session();
        fake.callTool.mockImplementation(async () => {
            throw new Error(TOKEN);
        });
        const mcp = new ApifyMcp({ token: TOKEN, connect: async () => fake });
        await expect(mcp.invoke({ tool: "get-actor-run", args: {} })).rejects.toThrow(
            "Remote effects may have occurred"
        );
        expect(fake.callTool).toHaveBeenCalledTimes(1);
        expect(fake.close).toHaveBeenCalledTimes(1);
        fake.callTool.mockImplementation(async () => ({ isError: true, content: [{ text: TOKEN }] }));
        await expect(mcp.invoke({ tool: "get-actor-run", args: {} })).rejects.toThrow("Apify MCP request failed");
    });

    test("run controls and dataset transforms reach the API; invalid spending/resource limits make no request", async () => {
        const stub = responder({
            data: { id: "runOne", status: "READY", defaultKeyValueStoreId: "storeOne", stats: { computeUnits: 1 } },
        });
        const client = new ApifyClient({ token: TOKEN, fetcher: stub.fetcher });
        const result = await client.start({
            actor: "alice/test",
            input: {},
            maxCost: 1,
            memory: 512,
            timeout: 60,
            waitSecs: 45,
            build: "beta",
        });
        expect(result.defaultKeyValueStoreId).toBe("storeOne");
        const query = stub.calls[0].url.searchParams;
        expect(Object.fromEntries(query)).toMatchObject({
            memory: "512",
            timeout: "60",
            waitForFinish: "45",
            build: "beta",
        });
        for (const overrides of [
            { memory: 129 },
            { timeout: 0 },
            { waitSecs: 46 },
            { maxCost: NaN },
            { maxItems: 0 },
        ]) {
            await expect(client.start({ actor: "alice/test", input: {}, maxCost: 1, ...overrides })).rejects.toThrow();
        }
        expect(stub.calls).toHaveLength(1);
        const rows = responder([]);
        await new ApifyClient({ fetcher: rows.fetcher }).items({
            dataset: "alice~test",
            limit: 2,
            offset: 1,
            clean: false,
            desc: true,
            omit: "private",
            flatten: "metadata",
        });
        expect(Object.fromEntries(rows.calls[0].url.searchParams)).toMatchObject({
            clean: "false",
            desc: "true",
            omit: "private",
            flatten: "metadata",
            limit: "2",
            offset: "1",
        });
    });
});
