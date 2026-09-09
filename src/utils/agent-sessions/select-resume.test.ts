import { expect, test } from "bun:test";
import { selectResumeSession } from "./select-resume";
import type { AgentSession, AgentSessionAdapter } from "./types";

const session = (sessionId: string, title: string): AgentSession => ({
    kind: "codex",
    sessionId,
    title,
    cwd: "/project",
    mtime: new Date(0),
    filePath: `/sessions/${sessionId}.jsonl`,
});
function adapter(sessions: AgentSession[], content: AgentSession[] = []): AgentSessionAdapter {
    return { kind: "codex", list: async () => sessions, search: async () => content };
}

test("an exact ID wins over another ID with the same prefix", async () => {
    const exact = session("abc", "one");
    expect(
        await selectResumeSession({
            adapter: adapter([session("abcd", "two"), exact]),
            query: "abc",
            interactive: false,
        })
    ).toBe(exact);
});
test("content matches are used after metadata and preserve provider scope", async () => {
    const native = session("native", "untitled");
    const other = { ...session("other", "invoice"), kind: "claude" as const };
    expect(
        await selectResumeSession({ adapter: adapter([], [other, native]), query: "invoice", interactive: false })
    ).toBe(native);
});
test("ambiguous and empty non-interactive results never silently resume a session", async () => {
    await expect(
        selectResumeSession({
            adapter: adapter([session("a", "invoice one"), session("b", "invoice two")]),
            query: "invoice",
            interactive: false,
        })
    ).rejects.toThrow("Multiple");
    await expect(selectResumeSession({ adapter: adapter([]), query: "missing", interactive: false })).rejects.toThrow(
        "No codex"
    );
});

test("a full native UUID is resumable outside the current project without --all", async () => {
    const foreign = { ...session("11111111-1111-4111-8111-111111111111", "Foreign topic"), cwd: "/other-project" };
    const scoped: AgentSessionAdapter = {
        kind: "codex",
        list: async (filters) => (!filters.cwd || filters.cwd === foreign.cwd ? [foreign] : []),
        search: async () => [],
    };
    expect(
        await selectResumeSession({
            adapter: scoped,
            query: foreign.sessionId,
            filters: { cwd: "/current-project" },
            interactive: false,
        })
    ).toBe(foreign);
    await expect(
        selectResumeSession({
            adapter: scoped,
            query: "Foreign topic",
            filters: { cwd: "/current-project" },
            interactive: false,
        })
    ).rejects.toThrow("No codex");
});

test("a canonical copy wins for an explicit UUID while a missing UUID never resumes a text mention", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const canonical = { ...session(id, "Copied"), sourceHome: "/canonical" };
    const old = { ...session(id, "Original"), sourceHome: "/old-home" };
    expect(
        await selectResumeSession({
            adapter: adapter([old, canonical]),
            query: id,
            preferredHome: "/canonical",
            interactive: false,
        })
    ).toBe(canonical);
    await expect(
        selectResumeSession({ adapter: adapter([], [session("unrelated", id)]), query: id, interactive: false })
    ).rejects.toThrow("No codex");
});
