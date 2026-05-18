import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("genesis-tools MCP server (stdio e2e)", () => {
    it("advertises question_answer and records via a real JSON-RPC call", async () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-e2e-"));
        const cfgPath = join(mkdtempSync(join(tmpdir(), "qa-e2e-cfg-")), "config.json");
        writeFileSync(
            cfgPath,
            SafeJSON.stringify({ sinks: { obsidian: false, sound: false, notify: false }, obsidianPathTemplate: "" })
        );
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ["run", join(import.meta.dir, "../index.ts"), "mcp"],
            env: {
                ...process.env,
                CLAUDE_CODE_SESSION_ID: "e2e-sess",
                CLAUDECODE: "1",
                QUESTION_LOG_BASE: logBase,
                QUESTION_CONFIG_PATH: cfgPath,
            },
        });
        const client = new Client({ name: "e2e", version: "1.0.0" });
        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain("question_answer");

        const res = await client.callTool({
            name: "question_answer",
            arguments: { question: "does the mcp path work?", answer: "yes — end to end", tag: "question" },
        });
        const text = (res.content as { type: string; text: string }[])[0].text;
        expect(text).toMatch(/Logged Q→A/);

        const files = readdirSync(logBase);
        expect(files.length).toBe(1);
        const row = SafeJSON.parse(readFileSync(join(logBase, files[0]), "utf8").trim()) as {
            question: string;
            source: string;
            sessionId: string;
        };
        expect(row.question).toBe("does the mcp path work?");
        expect(row.source).toBe("mcp");
        expect(row.sessionId).toBe("e2e-sess");

        await client.close();
    }, 15000);
});
