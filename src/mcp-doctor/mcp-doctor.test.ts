import { describe, expect, it } from "bun:test";
import { mergeServers } from "./lib/discovery";
import { detectDuplicateTools } from "./lib/duplicates";
import { probeServer } from "./lib/probe";
import { buildReport, classifyResult, formatHealthTable } from "./lib/report";
import { isInvalidServer, type NormalizedServer, type ProbeResult } from "./lib/types";

describe("mergeServers", () => {
    it("normalizes a stdio server from ~/.claude.json with source attribution", () => {
        const servers = mergeServers({
            claude: { mcpServers: { github: { command: "npx", args: ["-y", "server-github"] } } },
            mcp: null,
            cursor: null,
        });

        expect(servers).toHaveLength(1);
        const gh = servers[0];
        expect(gh.name).toBe("github");
        expect(gh.transport).toBe("stdio");
        expect(gh.source).toBe("~/.claude.json");
        if (gh.transport === "stdio" && !isInvalidServer(gh)) {
            expect(gh.command).toBe("npx");
            expect(gh.args).toEqual(["-y", "server-github"]);
        }
    });

    it("normalizes a remote server (url + type) and defaults type to http", () => {
        const servers = mergeServers({
            claude: {
                mcpServers: {
                    ctx: { url: "https://mcp.example.com/mcp" },
                    streamy: { url: "https://s.example.com/sse", type: "sse" },
                },
            },
            mcp: null,
            cursor: null,
        });

        const ctx = servers.find((s) => s.name === "ctx");
        const streamy = servers.find((s) => s.name === "streamy");
        expect(ctx?.transport).toBe("http");
        expect(streamy?.transport).toBe("sse");
    });

    it("lets a project .mcp.json server override the same name from ~/.claude.json", () => {
        const servers = mergeServers({
            claude: { mcpServers: { fs: { command: "old-fs" } } },
            mcp: { mcpServers: { fs: { command: "new-fs" } } },
            cursor: null,
        });

        expect(servers).toHaveLength(1);
        const fs = servers[0];
        expect(fs.source).toBe(".mcp.json");
        expect(fs.overrides).toBe("~/.claude.json");
        if (fs.transport === "stdio" && !isInvalidServer(fs)) {
            expect(fs.command).toBe("new-fs");
        }
    });

    it("marks a server with neither command nor url as invalid", () => {
        const servers = mergeServers({
            claude: { mcpServers: { broken: { foo: "bar" } } },
            mcp: null,
            cursor: null,
        });

        const broken = servers[0];
        expect(isInvalidServer(broken)).toBe(true);
        if (isInvalidServer(broken)) {
            expect(broken.invalidReason).toContain("command");
        }
    });

    it("keeps the attempted remote transport on a server with an invalid url", () => {
        const servers = mergeServers({
            claude: { mcpServers: { streamy: { url: "not a valid url", type: "sse" } } },
            mcp: null,
            cursor: null,
        });

        const streamy = servers[0];
        expect(streamy.transport).toBe("sse");
        expect(isInvalidServer(streamy)).toBe(true);
    });

    it("sorts output by server name for deterministic tables", () => {
        const servers = mergeServers({
            claude: { mcpServers: { zebra: { command: "z" }, alpha: { command: "a" } } },
            mcp: null,
            cursor: null,
        });

        expect(servers.map((s) => s.name)).toEqual(["alpha", "zebra"]);
    });
});

describe("classifyResult", () => {
    const base = { startedAt: 1_000, slowThresholdMs: 3_000 };

    it("returns ok when finished under the slow threshold", () => {
        const r = classifyResult({ ...base, finishedAt: 1_300, error: null });
        expect(r.status).toBe("ok");
        expect(r.latencyMs).toBe(300);
    });

    it("returns slow when latency exceeds the slow threshold", () => {
        const r = classifyResult({ ...base, finishedAt: 5_500, error: null });
        expect(r.status).toBe("slow");
        expect(r.latencyMs).toBe(4_500);
    });

    it("returns timeout when never finished", () => {
        const r = classifyResult({ ...base, finishedAt: null, error: null });
        expect(r.status).toBe("timeout");
        expect(r.latencyMs).toBeNull();
    });

    it("returns error when an error is present, even if finished", () => {
        const r = classifyResult({ ...base, finishedAt: 1_200, error: "ENOENT" });
        expect(r.status).toBe("error");
    });
});

describe("detectDuplicateTools", () => {
    it("reports a tool name exposed by 2+ servers with owning servers sorted", () => {
        const dups = detectDuplicateTools([
            { name: "jina", tools: ["read_url", "search_web"] },
            { name: "ctx", tools: ["read_url", "resolve"] },
            { name: "brave", tools: ["search_web"] },
        ]);

        expect(dups).toEqual([
            { tool: "read_url", servers: ["ctx", "jina"] },
            { tool: "search_web", servers: ["brave", "jina"] },
        ]);
    });

    it("returns empty when no tool name is shared", () => {
        const dups = detectDuplicateTools([
            { name: "a", tools: ["x"] },
            { name: "b", tools: ["y"] },
        ]);
        expect(dups).toEqual([]);
    });

    it("ignores duplicates within a single server", () => {
        const dups = detectDuplicateTools([{ name: "a", tools: ["x", "x"] }]);
        expect(dups).toEqual([]);
    });
});

function fakeProbe(over: Partial<ProbeResult>): ProbeResult {
    return {
        name: "srv",
        source: "~/.claude.json",
        transport: "stdio",
        status: "ok",
        latencyMs: 100,
        toolCount: 1,
        tools: ["t"],
        resourceCount: 0,
        promptCount: 0,
        serverInfo: null,
        error: null,
        ...over,
    };
}

describe("buildReport", () => {
    it("computes a summary and attaches duplicates", () => {
        const report = buildReport([
            fakeProbe({ name: "a", status: "ok", tools: ["read"] }),
            fakeProbe({ name: "b", status: "slow", tools: ["read"] }),
            fakeProbe({ name: "c", status: "error", tools: [], error: "boom" }),
        ]);

        expect(report.summary.total).toBe(3);
        expect(report.summary.ok).toBe(1);
        expect(report.summary.slow).toBe(1);
        expect(report.summary.error).toBe(1);
        expect(report.summary.duplicateTools).toBe(1);
        expect(report.duplicates[0]).toEqual({ tool: "read", servers: ["a", "b"] });
    });
});

describe("formatHealthTable", () => {
    it("renders the server name, status and a duplicates section", () => {
        const report = buildReport([
            fakeProbe({ name: "alpha", status: "ok", latencyMs: 120, toolCount: 4, tools: ["x"] }),
            fakeProbe({ name: "beta", status: "ok", latencyMs: 130, toolCount: 2, tools: ["x"] }),
        ]);
        const text = formatHealthTable(report);

        expect(text).toContain("alpha");
        expect(text).toContain("beta");
        expect(text).toContain("Duplicate tool names");
        expect(text).toContain("x");
    });

    it("shows the invalid reason as the note for an invalid server", () => {
        const report = buildReport([
            fakeProbe({
                name: "broken",
                status: "invalid",
                latencyMs: null,
                toolCount: 0,
                tools: [],
                error: 'invalid URL: "not a valid url"',
            }),
        ]);
        const text = formatHealthTable(report);

        expect(text).toContain("invalid URL");
    });
});

describe("probeServer", () => {
    it("resolves with a failed status instead of throwing when transport construction fails", async () => {
        const server: NormalizedServer = {
            name: "broken-remote",
            transport: "http",
            source: "~/.claude.json",
            url: "not a valid url",
        };

        const result = await probeServer(server, { timeoutMs: 1_000, slowThresholdMs: 3_000 });

        expect(result.status).not.toBe("invalid");
        expect(result.error).toBeTruthy();
        expect(result.name).toBe("broken-remote");
    });

    it("does not reject the surrounding Promise.all when one server has a malformed URL", async () => {
        const servers: NormalizedServer[] = [
            { name: "broken-a", transport: "http", source: "~/.claude.json", url: "not a valid url" },
            { name: "broken-b", transport: "sse", source: ".mcp.json", url: "://also-bad" },
        ];

        const results = await Promise.all(
            servers.map((s) => probeServer(s, { timeoutMs: 1_000, slowThresholdMs: 3_000 }))
        );

        expect(results).toHaveLength(2);
        for (const result of results) {
            expect(result.status).toBe("error");
        }
    });
});
