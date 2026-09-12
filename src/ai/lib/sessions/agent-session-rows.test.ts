import { expect, test } from "bun:test";
import type { AgentSessionRow } from "./agent-session-rows";

/**
 * The contract this file pins is the ROW SHAPE, because a reader outside this repo (the
 * Genesis menu-bar app) decodes it. The Claude-only fields must stay optional rather than
 * zero-filled: a `cacheTtlSec` of 0 reads as "the prompt cache expired right now", which is a
 * wrong answer where an absent field is an honest one.
 */

const codexRow: AgentSessionRow = {
    provider: "codex",
    sessionId: "01a0-codex",
    title: "rewind-improvements",
    cwd: "/projects/rewind",
    cwdShort: "~/projects/rewind",
    project: "rewind",
    mtime: 1_000,
    model: null,
    account: null,
    filePath: "/home/.codex/sessions/x.jsonl",
    sourceHome: "/home/.codex",
    archived: false,
};

test("a codex row carries no cache, context or cmux field at all", () => {
    // Not `=== 0`: the keys must be ABSENT, so a consumer can test for them.
    expect("cacheStatus" in codexRow).toBe(false);
    expect("contextTokens" in codexRow).toBe(false);
    expect("cmux" in codexRow).toBe(false);
    expect("lastUserAt" in codexRow).toBe(false);
});

test("a codex row's account is nullable, because Codex itself records none", () => {
    // Every Codex account shares one home, and neither a rollout's session_meta nor a `threads`
    // row carries an account. The SessionStart pin journal is the only record, so a session
    // started outside `tools codex run` — or before the hook learned about Codex — has none.
    expect(codexRow.account).toBeNull();
    expect(codexRow.sourceHome).toBe("/home/.codex");

    const pinned: AgentSessionRow = { ...codexRow, account: "work" };
    expect(pinned.account).toBe("work");
});

test("a claude row is the same shape with the extra fields filled", () => {
    const claudeRow: AgentSessionRow = {
        ...codexRow,
        provider: "claude",
        account: "work",
        model: "opus",
        cacheStatus: "HOT",
        cacheTtlSec: 3_400,
        contextTokens: 505_000,
        cmux: null,
    };

    expect(claudeRow.provider).toBe("claude");
    expect(claudeRow.cacheStatus).toBe("HOT");
    expect(claudeRow.contextTokens).toBe(505_000);
});
