import { describe, expect, it } from "bun:test";
import { agentSessionIds, assignedSessionId, resolveAgentHost } from "./agent-host";

describe("resolveAgentHost", () => {
    it("detects each host from its own session variable", () => {
        expect(resolveAgentHost({ CLAUDE_CODE_SESSION_ID: "c1" })).toMatchObject({
            agent: "claude-code",
            sessionId: "c1",
        });
        expect(resolveAgentHost({ CODEX_THREAD_ID: "x1" })).toMatchObject({ agent: "codex", sessionId: "x1" });
        expect(resolveAgentHost({ GROK_SESSION_ID: "g1" })).toMatchObject({ agent: "grok", sessionId: "g1" });
    });

    it("reports claude-code with a null id when only CLAUDECODE is set", () => {
        expect(resolveAgentHost({ CLAUDECODE: "1" })).toMatchObject({ agent: "claude-code", sessionId: null });
    });

    it("whitespace is not a session — an unset variable expands to it", () => {
        // PR #343 review t21.
        expect(resolveAgentHost({ GROK_SESSION_ID: "   " })).toEqual({
            agent: "unknown",
            sessionId: null,
            isInAgent: false,
        });
        expect(resolveAgentHost({ GROK_SESSION_ID: " g1 " })).toMatchObject({ agent: "grok", sessionId: "g1" });
    });

    it("is unknown outside any agent", () => {
        expect(resolveAgentHost({})).toEqual({ agent: "unknown", sessionId: null, isInAgent: false });
    });

    it("gives the outer host precedence, because a worker inherits its parent's env", () => {
        const env = { CLAUDE_CODE_SESSION_ID: "parent", CODEX_THREAD_ID: "worker", GROK_SESSION_ID: "other" };
        expect(resolveAgentHost(env)).toMatchObject({ agent: "claude-code", sessionId: "parent" });
    });
});

describe("agentSessionIds", () => {
    it("returns every id present, in precedence order", () => {
        const ids = agentSessionIds({ GROK_SESSION_ID: "g1", CLAUDE_CODE_SESSION_ID: "c1", CODEX_THREAD_ID: "x1" });
        expect(ids.map((i) => i.agent)).toEqual(["claude-code", "codex", "grok"]);
        expect(ids.map((i) => i.id)).toEqual(["c1", "x1", "g1"]);
        expect(ids[0].key).toBe("CLAUDE_CODE_SESSION_ID");
    });

    it("skips empty and whitespace-only values", () => {
        // An unset $CLAUDE_CODE_SESSION_ID in a shell command expands to "", and
        // an empty id must never be mistaken for a session.
        expect(agentSessionIds({ CLAUDE_CODE_SESSION_ID: "", GROK_SESSION_ID: "   " })).toEqual([]);
    });

    it("is empty outside any agent", () => {
        expect(agentSessionIds({})).toEqual([]);
    });
});

describe("assignedSessionId", () => {
    it("prefers GENESIS_AGENTS_SESSION, then GT_RENDEZVOUS_SESSION", () => {
        expect(assignedSessionId({ GENESIS_AGENTS_SESSION: "pinned", GT_RENDEZVOUS_SESSION: "parent" })).toBe("pinned");
        expect(assignedSessionId({ GT_RENDEZVOUS_SESSION: "parent" })).toBe("parent");
    });

    it("outranks every host id, so a nested worker cannot re-parent its children", () => {
        // PR #343 review t29: preferring the host id here put a nested worker's
        // children in a swarm its own parent was not in.
        const env = { GT_RENDEZVOUS_SESSION: "parent-swarm", CLAUDE_CODE_SESSION_ID: "own", CODEX_THREAD_ID: "own2" };
        expect(assignedSessionId(env)).toBe("parent-swarm");
    });

    it("is null when nobody assigned one, and ignores whitespace", () => {
        expect(assignedSessionId({})).toBeNull();
        expect(assignedSessionId({ GENESIS_AGENTS_SESSION: "  " })).toBeNull();
    });
});
