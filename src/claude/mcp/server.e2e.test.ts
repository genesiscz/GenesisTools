import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { optIn } from "@genesiscz/utils/test/skip";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

describe.if(optIn.e2e)("genesis-tools MCP server (stdio e2e)", () => {
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
                ...env.getProcessEnv(),
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

    it("advertises question_post and creates a pending form over JSON-RPC", async () => {
        // A scratch GENESIS_TOOLS_HOME keeps the form out of the real qa.db.
        const home = mkdtempSync(join(tmpdir(), "qa-e2e-home-"));
        const cfgPath = join(mkdtempSync(join(tmpdir(), "qa-e2e-cfg-")), "config.json");
        writeFileSync(
            cfgPath,
            SafeJSON.stringify({
                sinks: { obsidian: false, sound: false, notify: false, notifyPending: false },
                obsidianPathTemplate: "",
            })
        );
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ["run", join(import.meta.dir, "../index.ts"), "mcp"],
            env: {
                ...env.getProcessEnv(),
                CLAUDE_CODE_SESSION_ID: "e2e-sess",
                CLAUDECODE: "1",
                GENESIS_TOOLS_HOME: home,
                QUESTION_LOG_BASE: join(home, "qa-log"),
                QUESTION_CONFIG_PATH: cfgPath,
            },
        });
        const client = new Client({ name: "e2e", version: "1.0.0" });
        await client.connect(transport);

        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("question_post");
        expect(names).toContain("question_wait");
        // The log-after-the-fact tool survives alongside the blocking ask surface.
        expect(names).toContain("question_answer");

        const posted = await client.callTool({
            name: "question_post",
            arguments: { question: "does the ask path work?", choices: ["yes", "no"], projectPath: home },
        });
        const postedText = (posted.content as { type: string; text: string }[])[0].text;
        expect(postedText).toContain("[pending]");

        const polled = await client.callTool({ name: "question_poll", arguments: {} });
        const polledText = (polled.content as { type: string; text: string }[])[0].text;
        expect(polledText).toContain("does the ask path work?");

        await client.close();
    }, 20000);
});
