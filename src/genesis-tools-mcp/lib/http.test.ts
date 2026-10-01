import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCaller } from "@genesiscz/utils/agent/runtime";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CAPABILITIES_HEADER, serveGenesisToolsHttp } from "./http";

/**
 * One resident server, many sessions: each request must be recorded as the session that sent
 * it. The test server takes the caller from a test header; the gateway takes it from the socket.
 */
describe("genesis-tools MCP over HTTP (resident, per-request caller)", () => {
    const logBase = mkdtempSync(join(tmpdir(), "qa-http-"));
    const cwdA = realpathSync(mkdtempSync(join(tmpdir(), "caller-a-")));
    const cwdB = realpathSync(mkdtempSync(join(tmpdir(), "caller-b-")));
    const callers: Record<string, AgentCaller> = {
        a: { agent: "claude-code", sessionId: "session-alpha", cwd: cwdA },
        b: { agent: "codex", sessionId: null, cwd: cwdB },
    };
    let server: ReturnType<typeof Bun.serve>;

    beforeAll(() => {
        const cfgPath = join(mkdtempSync(join(tmpdir(), "qa-http-cfg-")), "config.json");
        writeFileSync(cfgPath, SafeJSON.stringify({ sinks: { obsidian: false, sound: false, notify: false } }));
        env.testing.set("QUESTION_LOG_BASE", logBase);
        env.testing.set("QUESTION_CONFIG_PATH", cfgPath);
        server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => serveGenesisToolsHttp(request, callers[request.headers.get("x-test-caller") ?? "a"]),
        });
    });

    afterAll(() => {
        server.stop(true);
        env.testing.unset("QUESTION_LOG_BASE");
        env.testing.unset("QUESTION_CONFIG_PATH");
    });

    async function connect(caller: string, capabilities: string): Promise<Client> {
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
            requestInit: { headers: { "x-test-caller": caller, [CAPABILITIES_HEADER]: capabilities } },
        });
        const client = new Client({ name: `test-${caller}`, version: "1" });
        await client.connect(transport);
        return client;
    }

    it("records each concurrent call as its own caller and filters tools by the capabilities header", async () => {
        const [a, b] = await Promise.all([connect("a", "question_answer,handoff"), connect("b", "question_answer")]);

        const toolsB = (await b.listTools()).tools.map((tool) => tool.name);
        expect(toolsB).toEqual(["question_answer"]);
        expect((await a.listTools()).tools.map((tool) => tool.name)).toContain("handoff_post");

        await Promise.all([
            a.callTool({ name: "question_answer", arguments: { question: "qa from a", answer: "x", tag: "action" } }),
            b.callTool({ name: "question_answer", arguments: { question: "qa from b", answer: "y", tag: "action" } }),
        ]);
        await Promise.all([a.close(), b.close()]);

        const rows = readdirSync(logBase).flatMap((file) =>
            readFileSync(join(logBase, file), "utf8")
                .trim()
                .split("\n")
                .map(
                    (line) =>
                        SafeJSON.parse(line) as { question: string; sessionId: string; cwd: string; agent: string }
                )
        );
        const byQuestion = Object.fromEntries(rows.map((row) => [row.question, row]));
        expect(byQuestion["qa from a"]).toMatchObject({ sessionId: "session-alpha", cwd: cwdA, agent: "claude-code" });
        expect(byQuestion["qa from b"]).toMatchObject({ sessionId: "unknown", cwd: cwdB, agent: "codex" });
    }, 20000);
});
