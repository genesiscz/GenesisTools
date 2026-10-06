import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { probeAll } from "../../commands/doctor.ts";
import { DIAGNOSTIC_HEADER, GATEWAY_HEADER, REDACTED } from "../auth/constants.ts";
import { mergeServers } from "./discovery.ts";
import { detectDuplicateTools } from "./duplicates.ts";
import { buildEnvReport, collectCommands, type EnvReport, runCommandString, splitPath } from "./env-report.ts";
import { probeServer, remoteRequestInit } from "./probe.ts";
import {
    buildReport,
    classifyResult,
    formatEmptyServersMessage,
    formatHealthTable,
    redactServerForOutput,
} from "./report.ts";
import { isInvalidServer, type NormalizedServer, type ProbeResult } from "./types.ts";

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

describe("mergeServers remote headers", () => {
    it("keeps the headers of a remote entry so a probe can send them", () => {
        const servers = mergeServers({
            claude: {
                mcpServers: {
                    gw: { type: "http", url: "http://127.0.0.1:1/mcp/gw", headers: { [GATEWAY_HEADER]: "tok" } },
                },
            },
            mcp: null,
            cursor: null,
        });

        const gw = servers[0];
        expect(isInvalidServer(gw)).toBe(false);
        if (gw.transport !== "stdio" && !isInvalidServer(gw)) {
            expect(gw.headers).toEqual({ [GATEWAY_HEADER]: "tok" });
        }
    });

    it("ignores header values that are not strings", () => {
        const servers = mergeServers({
            claude: { mcpServers: { r: { url: "https://r.example.com/mcp", headers: { A: "a", B: 1, C: null } } } },
            mcp: null,
            cursor: null,
        });

        const remote = servers[0];
        if (remote.transport !== "stdio" && !isInvalidServer(remote)) {
            expect(remote.headers).toEqual({ A: "a" });
        }
    });
});

describe("remoteRequestInit", () => {
    const remote = { name: "r", source: "~/.claude.json" as const, url: "https://r.example.com/mcp" };

    it("hands the entry headers to both remote transports", () => {
        const headers = { Authorization: "Bearer abc" };

        expect(remoteRequestInit({ ...remote, transport: "http", headers })).toEqual({ headers });
        expect(remoteRequestInit({ ...remote, transport: "sse", headers })).toEqual({ headers });
    });

    it("sends nothing extra when the entry has no headers", () => {
        expect(remoteRequestInit({ ...remote, transport: "http" })).toBeUndefined();
        expect(remoteRequestInit({ ...remote, transport: "http", headers: {} })).toBeUndefined();
    });

    it("marks the request as a diagnostic only when it carries the gateway token", () => {
        const viaGateway = remoteRequestInit({ ...remote, transport: "http", headers: { [GATEWAY_HEADER]: "tok" } });
        const hosted = remoteRequestInit({ ...remote, transport: "http", headers: { Authorization: "Bearer abc" } });

        expect(viaGateway).toEqual({ headers: { [GATEWAY_HEADER]: "tok", [DIAGNOSTIC_HEADER]: "1" } });
        expect(hosted).toEqual({ headers: { Authorization: "Bearer abc" } });
    });
});

describe("redactServerForOutput", () => {
    it("masks header values and env values but keeps the names", () => {
        const remote = redactServerForOutput({
            name: "gw",
            transport: "http",
            source: "~/.claude.json",
            url: "http://127.0.0.1:1/mcp/gw",
            headers: { [GATEWAY_HEADER]: "tok", "X-Other": "visible?" },
        });
        const stdio = redactServerForOutput({
            name: "s",
            transport: "stdio",
            source: ".mcp.json",
            command: "srv",
            args: [],
            env: { API_KEY: "sekret" },
        });

        expect(remote).toMatchObject({ headers: { [GATEWAY_HEADER]: REDACTED, "X-Other": REDACTED } });
        expect(stdio).toMatchObject({ env: { API_KEY: REDACTED } });
    });
});

describe("formatEmptyServersMessage", () => {
    // Regression test: #446 item 10 — the empty state said "No MCP servers
    // configured" with no hint about which files were read or what is excluded.
    it("names every config source it reads and excludes claude.ai connectors and plugins", () => {
        const message = formatEmptyServersMessage();

        expect(message).toContain("~/.claude.json");
        expect(message).toContain(".mcp.json");
        expect(message).toContain(".cursor/mcp.json");
        expect(message).toContain("claude.ai connectors");
        expect(message).toContain("plugin-provided servers");
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

describe("collectCommands", () => {
    it("runs the positional command first, then each COMMANDS entry, and drops empty entries", () => {
        expect(collectCommands(["which", "playwright"], "env; echo test ;;")).toEqual([
            "which playwright",
            "env",
            "echo test",
        ]);
    });

    it("returns nothing when there is neither a command nor COMMANDS", () => {
        expect(collectCommands([], undefined)).toEqual([]);
    });
});

describe("runCommandString", () => {
    const ok = { success: true, exitCode: 0, stdout: "/bin/x\n", stderr: "" };

    it("splits on whitespace and reports the command output", async () => {
        const seen: string[][] = [];
        const result = await runCommandString("  which   x ", async (parts) => {
            seen.push(parts);
            return ok;
        });

        expect(seen).toEqual([["which", "x"]]);
        expect(result).toEqual({ ...ok, command: "which   x" });
    });

    it("turns a thrown spawn error into a failed result instead of rejecting", async () => {
        const result = await runCommandString("nope", async () => {
            throw new Error("spawn nope ENOENT");
        });

        expect(result).toMatchObject({ success: false, exitCode: 1, command: "nope", error: "spawn nope ENOENT" });
    });

    it("fails an empty command without spawning", async () => {
        const result = await runCommandString("   ", async () => {
            throw new Error("must not run");
        });

        expect(result).toMatchObject({ success: false, error: "empty command" });
    });
});

describe("buildEnvReport", () => {
    const base = { stdout: "", stderr: "" };

    it("carries cwd, the whole env and PATH split into entries", () => {
        const report = buildEnvReport({
            cwd: "/work",
            env: { PATH: ["/usr/bin", "", "/opt/bin"].join(delimiter), HOME: "/home/x" },
            results: [],
        });

        expect(report).toEqual({
            success: true,
            exitCode: 0,
            cwd: "/work",
            path: ["/usr/bin", "/opt/bin"],
            env: { PATH: ["/usr/bin", "", "/opt/bin"].join(delimiter), HOME: "/home/x" },
            commands: [],
        });
    });

    it("takes the exit code of the last failing command", () => {
        const report = buildEnvReport({
            cwd: "/work",
            env: {},
            results: [
                { ...base, success: false, exitCode: 2, command: "a" },
                { ...base, success: true, exitCode: 0, command: "b" },
                { ...base, success: false, exitCode: 0, command: "c" },
            ],
        });

        expect(report.success).toBe(false);
        expect(report.exitCode).toBe(1);
    });

    it("reads PATH under the Windows spelling too", () => {
        expect(splitPath({ Path: ["one", "two"].join(delimiter) })).toEqual(["one", "two"]);
        expect(splitPath({})).toEqual([]);
    });
});

describe("doctor env", () => {
    const ENTRY = join(import.meta.dir, "..", "..", "index.ts");

    function runDoctorEnv({ commands, flags }: { commands: string; flags: string[] }) {
        // `env` is passed on purpose: Bun does not forward the test preload's sandbox variables to a child
        // spawned without one, so the child would otherwise run against the real home.
        const result = Bun.spawnSync(["bun", ENTRY, "doctor", "env", ...flags], {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, COMMANDS: commands },
        });

        return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    }

    it("kills a command that outlives --timeout and still reports the commands after it", () => {
        const result = runDoctorEnv({ commands: "sleep 30;echo after", flags: ["--timeout", "300"] });
        const report = SafeJSON.parse(result.stdout) as EnvReport;

        expect(result.code).toBe(1);
        expect(report.commands.map((command) => [command.command, command.success])).toEqual([
            ["sleep 30", false],
            ["echo after", true],
        ]);
        expect(report.commands[0].error).toContain("timed out after 300ms");
        expect(report.commands[1].stdout).toBe("after");
    });

    it("keeps the command arguments out of the day log, because they can carry a token", () => {
        const token = `sk-${crypto.randomUUID()}`;
        const result = runDoctorEnv({ commands: `echo Authorization:Bearer-${token}`, flags: [] });
        const logs = readdirSync(genesisToolsDir("logs")).map((name) =>
            readFileSync(join(genesisToolsDir("logs"), name), "utf8")
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(token);
        expect(logs.some((text) => text.includes("doctor env runs commands"))).toBe(true);
        expect(logs.some((text) => text.includes(token))).toBe(false);
    });

    it("rejects a --timeout that is not a positive number before it runs anything", () => {
        const result = runDoctorEnv({ commands: "echo never", flags: ["--timeout", "0"] });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Invalid --timeout value: "0"');
        expect(result.stdout).toBe("");
    });
});

describe("probeServer sends the entry headers", () => {
    const servers: Array<{ stop(closeActiveConnections?: boolean): unknown }> = [];

    afterEach(() => {
        for (const server of servers.splice(0)) {
            server.stop(true);
        }
    });

    /** A stand-in for the local MCP gateway: it answers the handshake only when the token header is present. */
    function fakeGateway(token: string): string {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                if (request.headers.get(GATEWAY_HEADER) !== token) {
                    return Response.json(
                        { jsonrpc: "2.0", error: { code: -32000, message: `missing ${GATEWAY_HEADER}` }, id: null },
                        { status: 401 }
                    );
                }

                if (request.method !== "POST") {
                    return new Response(null, { status: 405 });
                }

                const body = (await request.json()) as {
                    id?: number;
                    method: string;
                    params?: { protocolVersion?: string };
                };
                if (body.method === "initialize") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            protocolVersion: body.params?.protocolVersion,
                            capabilities: { tools: {} },
                            serverInfo: { name: "fake-gateway", version: "1.0.0" },
                        },
                    });
                }

                if (body.method === "tools/list") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] },
                    });
                }

                return new Response(null, { status: 202 });
            },
        });
        servers.push(server);

        return `http://127.0.0.1:${server.port}/mcp/fake`;
    }

    const opts = { timeoutMs: 5_000, slowThresholdMs: 3_000 };

    it("connects to a server that requires the gateway token header", async () => {
        const url = fakeGateway("local-token");
        const result = await probeServer(
            {
                name: "fake",
                transport: "http",
                source: "~/.claude.json",
                url,
                headers: { [GATEWAY_HEADER]: "local-token" },
            },
            opts
        );

        expect(result.error).toBeNull();
        expect(result.status).toBe("ok");
        expect(result.tools).toEqual(["ping"]);
    });

    it("reports the missing header when the entry carries none", async () => {
        const url = fakeGateway("local-token");
        const result = await probeServer({ name: "fake", transport: "http", source: "~/.claude.json", url }, opts);

        expect(result.status).toBe("error");
        expect(result.error).toContain(GATEWAY_HEADER);
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

    it("bounds connection fanout and preserves server order", async () => {
        const servers: NormalizedServer[] = Array.from({ length: 9 }, (_, index) => ({
            name: `server-${index}`,
            transport: "http" as const,
            source: "~/.claude.json" as const,
            url: `https://server-${index}.example.com/mcp`,
        }));
        let active = 0;
        let peak = 0;

        const results = await probeAll(
            servers,
            { timeout: "1000", slow: "3000" },
            {
                concurrency: 4,
                probe: async (server) => {
                    active += 1;
                    peak = Math.max(peak, active);
                    await Bun.sleep(1);
                    active -= 1;

                    return {
                        name: server.name,
                        source: server.source,
                        transport: server.transport,
                        status: "ok",
                        latencyMs: 1,
                        toolCount: 0,
                        tools: [],
                        resourceCount: 0,
                        promptCount: 0,
                        serverInfo: null,
                        error: null,
                    };
                },
            }
        );

        expect(peak).toBe(4);
        expect(results.map((result) => result.name)).toEqual(servers.map((server) => server.name));
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
