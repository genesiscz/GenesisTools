import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFeed, readFeed } from "@app/agents/lib/feed";
import { ensureSessionDir, sessionPaths } from "@app/agents/lib/paths";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    AgentsBridge,
    type AgentsTransport,
    type AgentsTransportSubscription,
    CliAgentsTransport,
} from "./agents-bridge";
import type { CodexControl } from "./control";

class FakeAgentsTransport implements AgentsTransport {
    readonly sent: Array<{ from: string; to: string; body: string; session: string }> = [];
    lineHandler: ((line: string) => void | Promise<void>) | null = null;

    async register(): Promise<string> {
        return "agt_0002";
    }

    async send(options: { from: string; to: string; body: string; session: string }): Promise<void> {
        this.sent.push(options);
    }

    async observe(
        _session: string,
        onLine: (line: string) => void | Promise<void>
    ): Promise<AgentsTransportSubscription> {
        this.lineHandler = onLine;
        return { close: async () => {} };
    }
}

describe("AgentsBridge", () => {
    test("the default transport appends messages in-process", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-agents-transport-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("parent-1");
            ensureSessionDir(paths);
            await appendFeed(paths, {
                type: "registered",
                agent_name: "lead",
                agent_id: "main_parent",
                awaiting_login: false,
                is_main: true,
                role: null,
                meta: {},
            });
            await appendFeed(paths, {
                type: "registered",
                agent_name: "codex_reviewer",
                agent_id: "agt_0002",
                awaiting_login: false,
                is_main: false,
                role: null,
                meta: {},
            });

            await new CliAgentsTransport().send({
                from: "codex_reviewer",
                to: "lead",
                body: '{"event":"turn_completed"}',
                session: "parent-1",
            });

            expect((await readFeed(paths)).at(-1)).toMatchObject({
                type: "message",
                from_agent_id: "agt_0002",
                to_agent_ids: ["main_parent"],
                body: '{"event":"turn_completed"}',
            });
        });
    });

    test("auto-registers and routes addressed controls", async () => {
        const transport = new FakeAgentsTransport();
        const controls: CodexControl[] = [];
        const bridge = new AgentsBridge({
            agentName: "codex_reviewer",
            rendezvousSession: "parent-1",
            transport,
            onControl: async (control) => {
                controls.push(control);
            },
        });

        await expect(bridge.start()).resolves.toBe("agt_0002");
        await transport.lineHandler?.(
            '{"seq":7,"type":"message","from_agent_id":"main_parent","from_agent_name":"lead","to_agent_ids":["agt_0002"],"body":"{\\"op\\":\\"steer\\",\\"body\\":\\"focus\\"}","message_id":"0001","meta":{},"private":false,"ts":"now"}'
        );
        await transport.lineHandler?.(
            '{"seq":8,"type":"message","from_agent_id":"agt_0003","from_agent_name":"other","to_agent_ids":["agt_0004"],"body":"ignore","message_id":"0002","meta":{},"private":false,"ts":"now"}'
        );
        await transport.lineHandler?.(
            '{"seq":9,"type":"message","from_agent_id":"main_parent","from_agent_name":"lead","to_agent_ids":["agt_0002"],"body":"{bad","message_id":"0003","meta":{},"private":false,"ts":"now"}'
        );
        await transport.lineHandler?.(
            '{"seq":10,"type":"message","from_agent_id":"main_parent","from_agent_name":"lead","to_agent_ids":["agt_0002"],"body":"{\\"op\\":\\"interrupt\\"}","message_id":"0004","meta":{},"private":false,"ts":"now"}'
        );

        expect(controls).toEqual([{ op: "steer", body: "focus", force: false }, { op: "interrupt" }]);
        expect(transport.sent.at(-1)?.body).toContain('"event":"error"');
        await bridge.close();
    });

    test("publishes milestone notifications to lead", async () => {
        const transport = new FakeAgentsTransport();
        const bridge = new AgentsBridge({
            agentName: "codex_reviewer",
            rendezvousSession: "parent-1",
            transport,
            onControl: async () => {},
        });
        await bridge.start();

        await bridge.publish({ method: "turn/started", params: { turn: { id: "turn-1" } } });
        await bridge.publish({
            method: "item/completed",
            params: {
                item: {
                    type: "commandExecution",
                    id: "item-1",
                    command: "tools agents message --to lead",
                    exitCode: 0,
                    aggregatedOutput: "private command output that must stay in the session log",
                },
            },
        });

        expect(transport.sent).toHaveLength(2);
        expect(transport.sent[0]?.body).toContain('"event":"turn_started"');
        expect(transport.sent[1]?.body).toContain('"event":"item"');
        expect(transport.sent[1]?.body).toContain('"itemType":"commandExecution"');
        expect(transport.sent[1]?.body).toContain('"summary":"tools agents message --to lead (exit 0)"');
        expect(transport.sent[1]?.body).not.toContain("private command output");
    });

    test("publishes failed and interrupted completed turns as errors", async () => {
        const transport = new FakeAgentsTransport();
        const bridge = new AgentsBridge({
            agentName: "codex_reviewer",
            rendezvousSession: "parent-1",
            transport,
            onControl: async () => {},
        });
        await bridge.start();

        await bridge.publish({
            method: "turn/completed",
            params: { turn: { id: "turn-failed", status: "failed", error: { message: "bad tool" } } },
        });
        await bridge.publish({
            method: "turn/completed",
            params: { turn: { id: "turn-stop", status: "interrupted" } },
        });
        await bridge.publish({
            method: "turn/completed",
            params: { turn: { id: "turn-ok", status: "completed" } },
        });

        expect(transport.sent.map((entry) => SafeJSON.parse(entry.body, { strict: true }))).toEqual([
            expect.objectContaining({ event: "error", outcome: "failed", turnId: "turn-failed" }),
            expect.objectContaining({ event: "error", outcome: "interrupted", turnId: "turn-stop" }),
            expect.objectContaining({ event: "turn_completed", turnId: "turn-ok" }),
        ]);
    });
});
