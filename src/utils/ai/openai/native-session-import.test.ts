import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, NativeSessionImportContext } from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { importNativeCodexSession } from "./native-session-import";

async function fixture(mode = "legacy") {
    const root = await mkdtemp(join(tmpdir(), "gt-copy-session-"));
    const target = join(root, "target");
    await mkdir(target);
    const source = join(root, "source.jsonl");
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const copyId = "22222222-2222-4222-8222-222222222222";
    const original = `${SafeJSON.stringify({ type: "session_meta", payload: { id: sourceId, history_mode: mode } })}\n`;
    await writeFile(source, original);
    const session: AgentSession = {
        kind: "codex",
        sessionId: sourceId,
        title: "Fixture",
        cwd: root,
        mtime: new Date(),
        filePath: source,
        sourceHome: root,
    };
    const calls: string[] = [];
    const copyPath = join(target, "sessions", "copied.jsonl");
    const thread = { id: copyId, path: copyPath, forkedFromId: sourceId };
    const context: NativeSessionImportContext = {
        targetHome: target,
        nativeClient: {
            async request<T>(method: string, params?: unknown): Promise<T> {
                calls.push(method);
                if (method === "thread/fork") {
                    const input = params as { path: string; deferGoalContinuation: boolean };
                    expect(input.path).not.toBe(source);
                    expect(await readFile(input.path, "utf8")).toBe(original);
                    expect(input.deferGoalContinuation).toBe(true);
                    await mkdir(join(target, "sessions"), { recursive: true });
                    await writeFile(copyPath, original);
                }
                return { thread } as T;
            },
        },
    };
    return { root, target, source, sourceId, copyId, original, session, context, calls };
}

test("native import copies from a snapshot, resumes the new ID and is idempotent", async () => {
    const f = await fixture();
    const copied = await importNativeCodexSession(f.session, f.context);
    expect(copied).toMatchObject({ sessionId: f.copyId, sourceSessionId: f.sourceId, copied: true });
    expect(f.calls).toContain("thread/fork");
    expect(f.calls).toContain("thread/resume");
    expect(await readFile(f.source, "utf8")).toBe(f.original);
    const again = await importNativeCodexSession(f.session, f.context);
    expect(again).toMatchObject({ sessionId: f.copyId, copied: false });
    expect(f.calls.filter((method) => method === "thread/fork")).toHaveLength(1);
});

test("unsupported paginated imports fail before any native request or target write", async () => {
    const f = await fixture("paginated");
    await expect(importNativeCodexSession(f.session, f.context)).rejects.toThrow("paginated");
    expect(f.calls).toEqual([]);
    expect(await readdir(f.target)).toEqual([]);
    expect(await readFile(f.source, "utf8")).toBe(f.original);
});

test("a changed source cannot silently replace the already copied session", async () => {
    const f = await fixture();
    await importNativeCodexSession(f.session, f.context);
    await writeFile(
        f.source,
        `${f.original + SafeJSON.stringify({ type: "event_msg", payload: { message: "new content" } })}\n`
    );
    await expect(importNativeCodexSession(f.session, f.context)).rejects.toThrow("changed");
    expect(f.calls.filter((method) => method === "thread/fork")).toHaveLength(1);
});

test("incomplete source records are rejected before starting a native copy", async () => {
    const f = await fixture();
    await writeFile(f.source, `${f.original}{"type":"response_item"`);
    await expect(importNativeCodexSession(f.session, f.context)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(await readdir(f.target)).toEqual([]);
});

test("an uncertain native failure retains recovery state and prevents duplicate retries", async () => {
    const f = await fixture();
    f.context.nativeClient = {
        async request<T>(): Promise<T> {
            throw new Error("transport lost after fork request");
        },
    };
    await expect(importNativeCodexSession(f.session, f.context)).rejects.toThrow("recovery");
    await expect(importNativeCodexSession(f.session, f.context)).rejects.toThrow("recovery");
    expect(await readFile(f.source, "utf8")).toBe(f.original);
});

test("a returned fork ID is deleted when the following verification fails", async () => {
    // Regression test: PR #370 review thread 9 — verification ran before the returned fork ID was recoverable.
    const f = await fixture();
    const deleted: string[] = [];
    f.context.nativeClient = {
        async request<T>(method: string, params?: unknown): Promise<T> {
            if (method === "thread/fork") {
                return {
                    thread: {
                        id: f.copyId,
                        path: join(f.target, "sessions", "copied.jsonl"),
                        forkedFromId: f.sourceId,
                    },
                } as T;
            }
            if (method === "thread/read") {
                throw new Error("fork verification failed");
            }
            if (method === "thread/delete") {
                deleted.push((params as { threadId: string }).threadId);
                return {} as T;
            }
            return {} as T;
        },
    };

    await expect(importNativeCodexSession(f.session, f.context)).rejects.toThrow("fork verification failed");
    expect(deleted).toEqual([f.copyId]);
});
