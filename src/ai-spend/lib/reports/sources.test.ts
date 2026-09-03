import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { isolateAgentHomeEnv } from "../drivers/test-env";
import {
    loadAmpEvents,
    loadCopilotEvents,
    loadDroidEvents,
    loadGeminiEvents,
    loadGooseEvents,
    loadHermesEvents,
    loadKimiEvents,
    loadOpenclawEvents,
    loadOpencodeEvents,
    loadPiEvents,
    loadQwenEvents,
} from "./sources";

isolateAgentHomeEnv();

function home(): string {
    return mkdtempSync(join(tmpdir(), "ai-spend-src-"));
}

describe("extra source loaders", () => {
    it("amp reads ledger token fields from a thread JSON file", () => {
        const root = home();
        const dir = join(root, ".local/share/amp/threads");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "T-abc.json"),
            SafeJSON.stringify({
                id: "T-abc",
                usageLedger: {
                    events: [
                        {
                            id: "e1",
                            timestamp: "2026-06-01T10:00:00.000Z",
                            model: "amp-model",
                            tokens: { input: 12, output: 3 },
                        },
                    ],
                },
            })
        );
        const events = loadAmpEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(12);
        expect(events[0].outputTokens).toBe(3);
        expect(events[0].sessionId).toBe("T-abc");
    });

    it("amp keeps a recorded cost of zero", () => {
        const root = home();
        const dir = join(root, ".local/share/amp/threads");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "T-zero.json"),
            SafeJSON.stringify({
                id: "T-zero",
                usageLedger: {
                    events: [
                        {
                            id: "e0",
                            timestamp: "2026-06-01T10:00:00.000Z",
                            model: "amp-model",
                            tokens: { input: 4, output: 1 },
                            credits: 0,
                        },
                    ],
                },
            })
        );
        const events = loadAmpEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].recordedCostUsd).toBe(0);
    });

    it("pi reads assistant usage from jsonl", () => {
        const root = home();
        const dir = join(root, ".pi/agent/sessions");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "sess.jsonl"),
            `${SafeJSON.stringify({
                type: "assistant",
                timestamp: "2026-06-01T10:00:00.000Z",
                message: {
                    role: "assistant",
                    model: "pi-model",
                    usage: { input: 8, output: 2, cacheRead: 4, cacheWrite: 1 },
                },
            })}\n`
        );
        const events = loadPiEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(8);
        expect(events[0].cacheReadTokens).toBe(4);
        expect(events[0].cacheCreationTokens).toBe(1);
    });

    it("droid reads tokenUsage from a settings file", () => {
        const root = home();
        const dir = join(root, ".factory/sessions");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "sess-d.settings.json"),
            SafeJSON.stringify({
                model: "droid-model",
                updatedAt: "2026-06-01T10:00:00.000Z",
                tokenUsage: { inputTokens: 9, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 5 },
            })
        );
        const events = loadDroidEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(9);
        expect(events[0].cacheReadTokens).toBe(5);
        expect(events[0].sessionId).toBe("sess-d");
    });

    it("copilot reads gen_ai usage attributes from otel jsonl", () => {
        const root = home();
        const dir = join(root, ".copilot/otel");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "trace.jsonl"),
            `${SafeJSON.stringify({
                spanId: "span-1",
                startTime: "2026-06-01T10:00:00.000Z",
                attributes: {
                    "gen_ai.usage.input_tokens": 20,
                    "gen_ai.usage.output_tokens": 4,
                    "gen_ai.usage.cache_read.input_tokens": 6,
                    "gen_ai.request.model": "gpt-4.1",
                    "session.id": "copilot-sess",
                },
            })}\n`
        );
        const events = loadCopilotEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(20);
        expect(events[0].outputTokens).toBe(4);
        expect(events[0].cacheReadTokens).toBe(6);
        expect(events[0].sessionId).toBe("copilot-sess");
    });

    it("opencode reads message rows from sqlite", () => {
        const root = home();
        const dir = join(root, ".local/share/opencode");
        mkdirSync(dir, { recursive: true });
        const db = new Database(join(dir, "opencode.db"));
        db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
        db.run("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)", [
            "m1",
            "s1",
            SafeJSON.stringify({
                id: "m1",
                modelID: "opencode-model",
                sessionID: "s1",
                time: { created: Date.parse("2026-06-01T10:00:00.000Z") },
                tokens: { input: 15, output: 5, cache: { read: 2, write: 1 } },
            }),
        ]);
        db.close();
        const events = loadOpencodeEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(15);
        expect(events[0].cacheReadTokens).toBe(2);
        expect(events[0].cacheCreationTokens).toBe(1);
    });

    it("hermes reads sessions from sqlite", () => {
        const root = home();
        const dir = join(root, ".hermes");
        mkdirSync(dir, { recursive: true });
        const db = new Database(join(dir, "state.db"));
        db.run(`CREATE TABLE sessions (
            id TEXT, model TEXT, billing_provider TEXT, started_at REAL, message_count INTEGER,
            input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
            reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL
        )`);
        db.run(`INSERT INTO sessions VALUES ('h1','hermes-model','x',?,?,?,?,?,?,?,?,?)`, [
            Date.parse("2026-06-01T10:00:00.000Z"),
            1,
            7,
            3,
            0,
            0,
            0,
            0,
            0.01,
        ]);
        db.close();
        const events = loadHermesEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(7);
        expect(events[0].outputTokens).toBe(3);
    });

    it("hermes keeps a present actual cost of zero over the estimate", () => {
        const root = home();
        const dir = join(root, ".hermes");
        mkdirSync(dir, { recursive: true });
        const db = new Database(join(dir, "state.db"));
        db.run(`CREATE TABLE sessions (
            id TEXT, model TEXT, billing_provider TEXT, started_at REAL, message_count INTEGER,
            input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
            reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL
        )`);
        db.run(`INSERT INTO sessions VALUES ('h0','hermes-model','x',?,?,?,?,?,?,?,?,?)`, [
            Date.parse("2026-06-01T10:00:00.000Z"),
            1,
            7,
            3,
            0,
            0,
            0,
            1.5,
            0,
        ]);
        db.close();
        const events = loadHermesEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].recordedCostUsd).toBe(0);
    });

    it("goose keeps a zero accumulated token count instead of the legacy field", () => {
        const root = home();
        const dir = join(root, ".local/share/goose/sessions");
        mkdirSync(dir, { recursive: true });
        const db = new Database(join(dir, "sessions.db"));
        db.run(`CREATE TABLE sessions (
            id TEXT, model_config_json TEXT, provider_name TEXT, created_at REAL, total_tokens INTEGER,
            input_tokens INTEGER, output_tokens INTEGER, accumulated_total_tokens INTEGER,
            accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER
        )`);
        db.run(`INSERT INTO sessions VALUES ('g0',?,?,?,?,?,?,?,?,?)`, [
            SafeJSON.stringify({ model_name: "goose-model" }),
            "x",
            Date.parse("2026-06-01T10:00:00.000Z"),
            5,
            99,
            1,
            5,
            0,
            5,
        ]);
        db.close();
        const events = loadGooseEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(0);
        expect(events[0].outputTokens).toBe(5);
    });

    it("kimi reads nested payload.token_usage from wire.jsonl", () => {
        const root = home();
        const dir = join(root, ".kimi/sessions/kimi-sess");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "wire.jsonl"),
            `${SafeJSON.stringify({
                timestamp: "2026-06-01T10:00:00.000Z",
                model: "kimi-for-coding",
                message: {
                    payload: {
                        message_id: "msg-k1",
                        token_usage: {
                            input_other: 100,
                            output: 50,
                            input_cache_creation: 20,
                            input_cache_read: 10,
                        },
                    },
                },
            })}\n`
        );
        const events = loadKimiEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].sessionId).toBe("kimi-sess");
        expect(events[0].inputTokens).toBe(100);
        expect(events[0].outputTokens).toBe(50);
        expect(events[0].cacheCreationTokens).toBe(20);
        expect(events[0].cacheReadTokens).toBe(10);
    });

    it("gemini reads both jsonl lines and a json messages array", () => {
        const root = home();
        const dir = join(root, ".gemini/tmp");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "sess-a.jsonl"),
            `${SafeJSON.stringify({
                id: "g1",
                sessionId: "gem-jsonl",
                model: "gemini-2.5-pro",
                timestamp: "2026-06-01T10:00:00.000Z",
                usage_metadata: { promptTokenCount: 11, candidatesTokenCount: 3, cachedContentTokenCount: 2 },
            })}\n`
        );
        writeFileSync(
            join(dir, "sess-b.json"),
            SafeJSON.stringify({
                messages: [
                    {
                        id: "g2",
                        sessionId: "gem-json",
                        model: "gemini-2.5-flash",
                        timestamp: "2026-06-01T11:00:00.000Z",
                        tokens: { input_tokens: 8, output_tokens: 4, cached_tokens: 1 },
                    },
                ],
            })
        );
        const events = loadGeminiEvents(root);
        expect(events).toHaveLength(2);
        const jsonl = events.find((event) => event.sessionId === "gem-jsonl");
        const json = events.find((event) => event.sessionId === "gem-json");
        expect(jsonl?.inputTokens).toBe(11);
        expect(jsonl?.outputTokens).toBe(3);
        expect(jsonl?.cacheReadTokens).toBe(2);
        expect(json?.inputTokens).toBe(8);
        expect(json?.outputTokens).toBe(4);
        expect(json?.cacheReadTokens).toBe(1);
    });

    it("qwen reads usageMetadata including thoughtsTokenCount", () => {
        const root = home();
        const dir = join(root, ".qwen/projects/myProject/chats");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "chat-a.jsonl"),
            `${SafeJSON.stringify({
                type: "assistant",
                model: "qwen3-coder-plus",
                timestamp: "2026-06-01T10:00:00.000Z",
                sessionId: "qwen-sess",
                usageMetadata: {
                    promptTokenCount: 100,
                    candidatesTokenCount: 50,
                    thoughtsTokenCount: 10,
                    cachedContentTokenCount: 5,
                },
            })}\n`
        );
        const events = loadQwenEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].sessionId).toBe("qwen-sess");
        expect(events[0].inputTokens).toBe(100);
        expect(events[0].outputTokens).toBe(50);
        expect(events[0].cacheReadTokens).toBe(5);
        expect(events[0].reasoningOutputTokens).toBe(10);
    });

    it("openclaw uses a sticky model from a model_change line", () => {
        const root = home();
        const dir = join(root, ".openclaw/agents/main/sessions");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "abc.jsonl"),
            [
                SafeJSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.2" }),
                SafeJSON.stringify({
                    type: "message",
                    timestamp: "2026-06-01T10:00:00.000Z",
                    message: {
                        role: "assistant",
                        usage: { input: 16, output: 5, cacheRead: 8, cost: { total: 0.02 } },
                    },
                }),
            ].join("\n")
        );
        const events = loadOpenclawEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0].sessionId).toBe("abc");
        expect(events[0].model).toBe("gpt-5.2");
        expect(events[0].inputTokens).toBe(16);
        expect(events[0].outputTokens).toBe(5);
        expect(events[0].cacheReadTokens).toBe(8);
        expect(events[0].recordedCostUsd).toBe(0.02);
    });

    it("skips a malformed amp thread instead of throwing", () => {
        const root = home();
        const dir = join(root, ".local/share/amp/threads");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "T-bad.json"), "{not json");
        expect(loadAmpEvents(root)).toEqual([]);
    });
});
