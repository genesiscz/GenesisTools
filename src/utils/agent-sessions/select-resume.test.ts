import { afterEach, expect, test } from "bun:test";
import { out } from "@genesiscz/utils/logger";
import { selectResumeSession } from "./select-resume";
import type { AgentSession, AgentSessionAdapter } from "./types";

const realPrintln = out.println;

/** Capture the candidate table an ambiguous non-interactive resume prints before it fails. */
function capturePrinted(): string[] {
    const lines: string[] = [];
    out.println = (raw?: unknown, ...rest: unknown[]) => {
        lines.push([raw, ...rest].map(String).join(" "));
    };

    return lines;
}

afterEach(() => {
    out.println = realPrintln;
});

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
    ).rejects.toThrow("Ambiguous");
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

test("a title match resolves to the launch home's copy, but two different sessions stay ambiguous", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const local = { ...session(id, "astra-pricing"), sourceHome: "/home" };
    const retained = { ...session(id, "astra-pricing"), sourceHome: "/old-home" };
    expect(
        await selectResumeSession({
            adapter: adapter([retained, local]),
            query: "astra-pricing",
            preferredHome: "/home",
            interactive: false,
        })
    ).toBe(local);
    const other = { ...session("44444444-4444-4444-8444-444444444444", "astra-pricing"), sourceHome: "/old-home" };
    await expect(
        selectResumeSession({
            adapter: adapter([other, local]),
            query: "astra-pricing",
            preferredHome: "/home",
            interactive: false,
        })
    ).rejects.toThrow("Ambiguous");
});
test("an ambiguous non-interactive resume prints the candidates before it refuses", async () => {
    // Naming only the count tells the user the query was too broad and nothing about which
    // query would be narrow enough. Claude's resume has always printed the table; the shared
    // path named the count alone, so codex and grok had no way to pick a session id.
    const printed = capturePrinted();

    await expect(
        selectResumeSession({
            adapter: adapter([session("aaaa1111", "invoice one"), session("bbbb2222", "invoice two")]),
            query: "invoice",
            interactive: false,
        })
    ).rejects.toThrow("Pass a session id from the table above");

    const table = printed.join("\n");
    expect(table).toContain("aaaa1111");
    expect(table).toContain("bbbb2222");
    expect(table).toContain("invoice one");
    expect(table).toContain("SESSION ID");
});

test("NEGATIVE CONTROL: a resolved resume prints no candidate table", async () => {
    const printed = capturePrinted();

    expect(
        await selectResumeSession({
            adapter: adapter([session("aaaa1111", "invoice one")]),
            query: "invoice",
            interactive: false,
        })
    ).toBeDefined();
    expect(printed).toEqual([]);
});
