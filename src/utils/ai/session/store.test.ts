import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createJsonFilesBackend } from "./backends/json-files";
import { createSessionStore } from "./store";
import { SessionBusyError } from "./types";

/**
 * A session file as ChatSessionManager writes them today (redacted from a real
 * ~/.genesis-tools/ai-chat/sessions file): one JSON object per line, config
 * first, trailing newline. If this stops loading, every existing ask session is
 * unreadable.
 */
const LEGACY_SESSION_JSONL = `${[
    {
        type: "config",
        timestamp: "2026-07-01T10:00:00.000Z",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        systemPrompt: "You are a helpful assistant.",
    },
    { type: "user", content: "hello", timestamp: "2026-07-01T10:00:01.000Z" },
    {
        type: "assistant",
        content: "hi there",
        thinking: "greeting",
        timestamp: "2026-07-01T10:00:03.000Z",
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        cost: 0.00012,
    },
    { type: "system", content: "tone: terse", timestamp: "2026-07-01T10:00:04.000Z" },
    {
        type: "context",
        content: "file contents",
        timestamp: "2026-07-01T10:00:05.000Z",
        label: "README.md",
        metadata: { bytes: 42 },
    },
]
    .map((entry) => SafeJSON.stringify(entry))
    .join("\n")}\n`;

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gt-session-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("json-files backend", () => {
    test("loads a pre-phase ask session file with every entry type", async () => {
        writeFileSync(join(dir, "legacy.jsonl"), LEGACY_SESSION_JSONL);
        const backend = createJsonFilesBackend({ dir });

        const session = await backend.byTitle("anyone", "legacy");
        expect(session).toBeDefined();
        expect(session?.id).toBe("legacy");
        expect(session?.createdAt).toBe(Date.parse("2026-07-01T10:00:00.000Z"));
        expect(session?.updatedAt).toBe(Date.parse("2026-07-01T10:00:05.000Z"));

        const messages = await backend.messages("legacy");
        expect(messages.map((m) => m.role)).toEqual(["config", "user", "assistant", "system", "context"]);
        expect(messages[0].meta).toEqual({
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            systemPrompt: "You are a helpful assistant.",
        });
        expect(messages[2].meta).toEqual({
            thinking: "greeting",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            cost: 0.00012,
        });
        expect(messages[4].meta).toEqual({ label: "README.md", metadata: { bytes: 42 } });
    });

    test("appended entries round-trip back to the same on-disk shape", async () => {
        const backend = createJsonFilesBackend({ dir });
        await backend.create({ owner: "u", title: "round" });

        await backend.append({ sessionId: "round", role: "config", content: "", meta: { provider: "p", model: "m" } });
        await backend.append({ sessionId: "round", role: "user", content: "q", meta: { metadata: { a: 1 } } });
        await backend.append({
            sessionId: "round",
            role: "assistant",
            content: "a",
            meta: { cost: 0.5, usage: { totalTokens: 3 } },
        });
        await backend.append({ sessionId: "round", role: "context", content: "ctx", meta: { label: "L" } });

        const lines = readFileSync(join(dir, "round.jsonl"), "utf8").trim().split("\n");
        expect(lines).toHaveLength(4);
        const parsed = lines.map((line) => SafeJSON.parse(line, { strict: true, unbox: true }) as { type: string });
        expect(parsed.map((p) => p.type)).toEqual(["config", "user", "assistant", "context"]);
        expect(parsed[0]).toMatchObject({ provider: "p", model: "m" });
        expect(parsed[1]).toMatchObject({ content: "q", metadata: { a: 1 } });
        expect(parsed[2]).toMatchObject({ content: "a", cost: 0.5 });
        expect(parsed[3]).toMatchObject({ content: "ctx", label: "L" });

        const messages = await backend.messages("round");
        expect(messages[1].meta).toEqual({ metadata: { a: 1 } });
        expect(messages[3].meta).toEqual({ label: "L" });
    });

    test("list sorts by last activity and byId misses are undefined", async () => {
        writeFileSync(join(dir, "old.jsonl"), LEGACY_SESSION_JSONL);
        const backend = createJsonFilesBackend({ dir });
        await backend.create({ owner: "u", title: "fresh" });
        await backend.append({ sessionId: "fresh", role: "user", content: "now" });

        const list = await backend.list("u");
        expect(list.map((s) => s.id)).toEqual(["fresh", "old"]);
        expect(await backend.byId("nope")).toBeUndefined();
    });

    test("rejects ids that would escape the session directory", async () => {
        const backend = createJsonFilesBackend({ dir });
        await expect(backend.create({ owner: "u", title: "../escape" })).rejects.toThrow("Invalid session id");
    });
});

describe("session store", () => {
    test("getOrCreate returns the existing session on the second call", async () => {
        const store = createSessionStore(createJsonFilesBackend({ dir }));

        const first = await store.getOrCreate("u", "chat");
        const second = await store.getOrCreate("u", "chat");
        expect(second.id).toBe(first.id);
    });

    test("turn appends user before responding and assistant after", async () => {
        const store = createSessionStore(createJsonFilesBackend({ dir }));
        const session = await store.getOrCreate("u", "chat");
        const seen: string[][] = [];

        await store.turn(session.id, "q1", async (history) => {
            seen.push(history.map((m) => `${m.role}:${m.content}`));
            return "a1";
        });
        await store.turn(session.id, "q2", async (history) => {
            seen.push(history.map((m) => `${m.role}:${m.content}`));
            return "a2";
        });

        expect(seen[0]).toEqual(["user:q1"]);
        expect(seen[1]).toEqual(["user:q1", "assistant:a1", "user:q2"]);
        const history = await store.history(session.id);
        expect(history.map((m) => m.content)).toEqual(["q1", "a1", "q2", "a2"]);
    });

    test("a reply object contributes meta the caller could not know up front", async () => {
        const store = createSessionStore(createJsonFilesBackend({ dir }));
        const session = await store.getOrCreate("u", "chat");

        const assistant = await store.turn(session.id, "q", async () => ({ text: "a", meta: { cost: 0.25 } }), {
            assistant: { thinking: "t" },
        });

        expect(assistant.meta).toEqual({ thinking: "t", cost: 0.25 });
    });

    test("a second turn while one is in flight throws SessionBusyError", async () => {
        const store = createSessionStore(createJsonFilesBackend({ dir }));
        const session = await store.getOrCreate("u", "chat");
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const first = store.turn(session.id, "q1", async () => {
            await gate;
            return "a1";
        });

        await expect(store.turn(session.id, "q2", async () => "a2")).rejects.toBeInstanceOf(SessionBusyError);
        release();
        await first;

        // The rejected turn left nothing behind.
        const history = await store.history(session.id);
        expect(history.map((m) => m.content)).toEqual(["q1", "a1"]);
    });

    test("the busy flag clears after a failed turn", async () => {
        const store = createSessionStore(createJsonFilesBackend({ dir }));
        const session = await store.getOrCreate("u", "chat");

        await expect(
            store.turn(session.id, "q", async () => {
                throw new Error("model exploded");
            })
        ).rejects.toThrow("model exploded");

        const assistant = await store.turn(session.id, "retry", async () => "ok");
        expect(assistant.content).toBe("ok");
    });
});
