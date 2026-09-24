import { expect, test } from "bun:test";
import { CODEX_CACHE_TTL_MS, computeCacheStatus, GROK_CACHE_TTL_MS } from "@app/claude/lib/usage/session-rows";
import type { AgentSessionRow } from "./agent-session-rows";

/**
 * The contract this file pins is the ROW SHAPE, because a reader outside this repo (the
 * Genesis menu-bar app) decodes it. A `cacheTtlSec` of 0 reads as "the prompt cache expired
 * right now", which is a wrong answer where an absent field is an honest one. Claude, Codex
 * and Grok now all report a clock; a payload that omits the keys must still decode as absent
 * on the Swift side, which is a Genesis test, not this one.
 */

function coolingRow(provider: AgentSessionRow["provider"], ttlMs: number): AgentSessionRow {
    const now = 1_800_000_000_000;
    const lastCacheAt = now - 20 * 60 * 1000;
    const { status, ttlSec } = computeCacheStatus(lastCacheAt, now, ttlMs);

    return {
        provider,
        sessionId: `01a0-${provider}`,
        title: "rewind-improvements",
        cwd: "/projects/rewind",
        cwdShort: "~/projects/rewind",
        project: "rewind",
        mtime: lastCacheAt,
        lastCacheAt,
        model: null,
        account: null,
        filePath: `/home/.${provider}/sessions/x.jsonl`,
        sourceHome: `/home/.${provider}`,
        archived: false,
        cacheStatus: status,
        cacheTtlSec: ttlSec,
        cacheLifetimeSec: Math.ceil(ttlMs / 1000),
    };
}

test("a codex row reports the 30-minute subscription cache clock", () => {
    const row = coolingRow("codex", CODEX_CACHE_TTL_MS);
    expect(row.cacheStatus).toBe("COOLING");
    expect(row.cacheTtlSec).toBe(600);
    expect(row.cacheLifetimeSec).toBe(1800);
    expect("contextTokens" in row).toBe(false);
});

test("a grok row reports the 30-minute warning clock", () => {
    const row = coolingRow("grok", GROK_CACHE_TTL_MS);
    expect(row.cacheStatus).toBe("COOLING");
    expect(row.cacheTtlSec).toBe(600);
    expect(row.cacheLifetimeSec).toBe(1800);
    expect("contextTokens" in row).toBe(false);
});

test("a codex row's account is nullable, because Codex itself records none", () => {
    // Every Codex account shares one home, and neither a rollout's session_meta nor a `threads`
    // row carries an account. The SessionStart pin journal is the only record, so a session
    // started outside `tools codex run` — or before the hook learned about Codex — has none.
    const row: AgentSessionRow = {
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

    expect(row.account).toBeNull();
    expect(row.sourceHome).toBe("/home/.codex");

    const pinned: AgentSessionRow = { ...row, account: "work" };
    expect(pinned.account).toBe("work");
});

test("a claude row is the same shape with the extra fields filled", () => {
    const claudeRow: AgentSessionRow = {
        provider: "claude",
        sessionId: "01a0-claude",
        title: "rewind-improvements",
        cwd: "/projects/rewind",
        cwdShort: "~/projects/rewind",
        project: "rewind",
        mtime: 1_000,
        lastCacheAt: 1_000,
        model: "opus",
        account: "work",
        filePath: "/home/.claude/x.jsonl",
        cacheStatus: "HOT",
        cacheTtlSec: 3_400,
        cacheLifetimeSec: 3600,
        contextTokens: 505_000,
        cmux: null,
    };

    expect(claudeRow.provider).toBe("claude");
    expect(claudeRow.cacheStatus).toBe("HOT");
    expect(claudeRow.cacheLifetimeSec).toBe(3600);
    expect(claudeRow.contextTokens).toBe(505_000);
});
