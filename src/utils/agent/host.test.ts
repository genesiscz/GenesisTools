import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountEnvVar } from "@genesiscz/utils/ai/account-env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    AGENT_SESSION_KEYS,
    ASSIGNED_SESSION_KEYS,
    agentSessionIds,
    assignedSessionId,
    resolveAgentHost,
} from "./host";
import { whoIsCalling } from "./identity";

describe("resolveAgentHost", () => {
    it("detects each host from its own session variable", () => {
        expect(resolveAgentHost({ CLAUDE_CODE_SESSION_ID: "c1" })).toMatchObject({
            agent: "claude-code",
            sessionId: "c1",
        });
        expect(resolveAgentHost({ CODEX_THREAD_ID: "x1" })).toMatchObject({ agent: "codex", sessionId: "x1" });
        expect(resolveAgentHost({ GROK_SESSION_ID: "g1" })).toMatchObject({ agent: "grok", sessionId: "g1" });
        expect(resolveAgentHost({ COPILOT_AGENT_SESSION_ID: "p1" })).toMatchObject({
            agent: "copilot",
            sessionId: "p1",
        });
    });

    it("gives Copilot CLI a real id, so it can claim a handoff", () => {
        // 2026-08-31: COPILOT_AGENT_SESSION_ID was in the MCP server's env all
        // along and nothing read it, so every Copilot handoff event landed as
        // agent "unknown" with a null id — and a null id cannot claim.
        const uuid = "3bf1c496-8e82-4cb6-b688-bf65fd3d250a";
        expect(resolveAgentHost({ COPILOT_AGENT_SESSION_ID: uuid })).toEqual({
            agent: "copilot",
            sessionId: uuid,
            isInAgent: true,
            aiAgent: null,
        });
    });

    it("whitespace is not a Copilot session either", () => {
        expect(resolveAgentHost({ COPILOT_AGENT_SESSION_ID: "   " })).toEqual({
            agent: "unknown",
            sessionId: null,
            isInAgent: false,
        });
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
        const env = {
            CLAUDE_CODE_SESSION_ID: "parent",
            CODEX_THREAD_ID: "worker",
            GROK_SESSION_ID: "other",
            COPILOT_AGENT_SESSION_ID: "another",
        };
        expect(resolveAgentHost(env)).toMatchObject({ agent: "claude-code", sessionId: "parent" });
    });
});

describe("agentSessionIds", () => {
    it("returns every id present, in precedence order", () => {
        const ids = agentSessionIds({
            GROK_SESSION_ID: "g1",
            CLAUDE_CODE_SESSION_ID: "c1",
            CODEX_THREAD_ID: "x1",
            COPILOT_AGENT_SESSION_ID: "p1",
        });
        expect(ids.map((i) => i.agent)).toEqual(["claude-code", "codex", "grok", "copilot"]);
        expect(ids.map((i) => i.id)).toEqual(["c1", "x1", "g1", "p1"]);
        expect(ids[0].key).toBe("CLAUDE_CODE_SESSION_ID");
    });

    it("finds a lone Copilot id, which is the whole point for a bare copilot session", () => {
        expect(agentSessionIds({ COPILOT_AGENT_SESSION_ID: "p1" })).toEqual([
            { agent: "copilot", key: "COPILOT_AGENT_SESSION_ID", id: "p1" },
        ]);
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

// Characterization tests (2026-11-04): what the host chain answers today, before the gatherers are unified.
describe("characterization: the host table", () => {
    it("lists the session variables in precedence order, the three harnesses first and Copilot last", () => {
        expect(AGENT_SESSION_KEYS).toEqual([
            { agent: "claude-code", key: "CLAUDE_CODE_SESSION_ID" },
            { agent: "codex", key: "CODEX_THREAD_ID" },
            { agent: "grok", key: "GROK_SESSION_ID" },
            { agent: "copilot", key: "COPILOT_AGENT_SESSION_ID" },
        ]);
    });

    it("lists the assigned-session variables with the user's pin ahead of the spawner's", () => {
        expect([...ASSIGNED_SESSION_KEYS]).toEqual(["GENESIS_AGENTS_SESSION", "GT_RENDEZVOUS_SESSION"]);
    });

    it("agentSessionIds names each id with the variable it came from, trimmed", () => {
        expect(
            agentSessionIds({
                CLAUDE_CODE_SESSION_ID: " c1 ",
                CODEX_THREAD_ID: "x1",
                GROK_SESSION_ID: "g1",
                COPILOT_AGENT_SESSION_ID: "p1",
            })
        ).toEqual([
            { agent: "claude-code", key: "CLAUDE_CODE_SESSION_ID", id: "c1" },
            { agent: "codex", key: "CODEX_THREAD_ID", id: "x1" },
            { agent: "grok", key: "GROK_SESSION_ID", id: "g1" },
            { agent: "copilot", key: "COPILOT_AGENT_SESSION_ID", id: "p1" },
        ]);
    });

    it("agentSessionIds does not read CLAUDECODE or CODEX_CI, which carry no id", () => {
        expect(agentSessionIds({ CLAUDECODE: "1", CODEX_CI: "1" })).toEqual([]);
    });

    it("assignedSessionId trims its value and takes the first non-blank key", () => {
        expect(assignedSessionId({ GENESIS_AGENTS_SESSION: "  ", GT_RENDEZVOUS_SESSION: " parent " })).toBe("parent");
    });
});

describe("characterization: what each host resolves", () => {
    it("Claude: the flag follows CLAUDECODE, and the label follows AI_AGENT", () => {
        expect(resolveAgentHost({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "c1", AI_AGENT: "label" })).toEqual({
            agent: "claude-code",
            sessionId: "c1",
            isInAgent: true,
            aiAgent: "label",
        });
        expect(resolveAgentHost({ CLAUDE_CODE_SESSION_ID: "c1" })).toEqual({
            agent: "claude-code",
            sessionId: "c1",
            isInAgent: false,
            aiAgent: null,
        });
    });

    it("Claude: the session id is trimmed, like Grok's and Copilot's", () => {
        expect(resolveAgentHost({ CLAUDE_CODE_SESSION_ID: " c1 " })).toMatchObject({ sessionId: "c1" });
        expect(resolveAgentHost({ CODEX_THREAD_ID: " x1 " })).toMatchObject({ sessionId: "x1" });
    });

    it("Codex: CODEX_CI alone is a host without a session, and aiAgent is always null", () => {
        expect(resolveAgentHost({ CODEX_CI: "1", AI_AGENT: "label" })).toEqual({
            agent: "codex",
            sessionId: null,
            isInAgent: true,
            aiAgent: null,
        });
        expect(resolveAgentHost({ CODEX_CI: "0" })).toEqual({ agent: "unknown", sessionId: null, isInAgent: false });
    });

    it("Grok: the host is always isInAgent and takes AI_AGENT", () => {
        expect(resolveAgentHost({ GROK_SESSION_ID: "g1", AI_AGENT: "label" })).toEqual({
            agent: "grok",
            sessionId: "g1",
            isInAgent: true,
            aiAgent: "label",
        });
    });

    it("Copilot: takes AI_AGENT, trims the id, and loses to every harness that is present", () => {
        expect(resolveAgentHost({ COPILOT_AGENT_SESSION_ID: " p1 ", AI_AGENT: "label" })).toEqual({
            agent: "copilot",
            sessionId: "p1",
            isInAgent: true,
            aiAgent: "label",
        });
        expect(resolveAgentHost({ COPILOT_AGENT_SESSION_ID: "p1", GROK_SESSION_ID: "g1" })).toMatchObject({
            agent: "grok",
        });
    });

    it("Codex wins over Grok and Copilot, and Grok wins over Copilot", () => {
        expect(resolveAgentHost({ CODEX_CI: "1", GROK_SESSION_ID: "g1", COPILOT_AGENT_SESSION_ID: "p1" }).agent).toBe(
            "codex"
        );
        expect(resolveAgentHost({ GROK_SESSION_ID: "g1", COPILOT_AGENT_SESSION_ID: "p1" }).agent).toBe("grok");
    });

    it("a host with no T3 Code enricher says nothing about T3CODE_THREAD_ID today", () => {
        expect(resolveAgentHost({ CLAUDE_CODE_SESSION_ID: "c1", T3CODE_THREAD_ID: "t3-thread" })).toEqual({
            agent: "claude-code",
            sessionId: "c1",
            isInAgent: false,
            aiAgent: null,
        });
    });
});

describe("the enrichers the gatherer unification added (agent identity module)", () => {
    const NOW = new Date(2026, 10, 4, 12, 0, 0);

    it("the T3 Code enricher: T3CODE_THREAD_ID gives the host app t3code with its thread id", () => {
        const identity = whoIsCalling({
            origin: "local",
            env: { CODEX_THREAD_ID: "x1", T3CODE_THREAD_ID: "t3-thread" },
        });
        expect(identity.host).toEqual({ app: "t3code", threadId: "t3-thread" });
        expect(identity.sources.host).toBe("t3code");
    });

    it("the Claude subagent id: a Claude hook payload's agent_id reaches the runtime context as the subagent id", () => {
        // payload.ts turns `agent_id` into these typed facts (hooks.test.ts pins that half).
        const identity = whoIsCalling({
            origin: "local",
            env: { CLAUDE_CODE_SESSION_ID: "c1" },
            hook: { caller: "claude", sessionId: "c1", subagentId: "agent-7", toolUseId: "t" },
        });
        expect(identity).toMatchObject({
            agent: "claude-code",
            sessionId: "c1",
            subagentId: "agent-7",
            toolUseId: "t",
        });
    });

    it("the account inside Codex: TOOLS_CODEX_ACCOUNT names the account of a Codex caller", () => {
        const env = { CODEX_THREAD_ID: "x1", [accountEnvVar("codex")]: "work" };
        expect(whoIsCalling({ origin: "local", env }).account).toEqual({
            harness: "codex",
            account: "work",
            proxyTarget: null,
        });
    });

    it("the account inside Grok: TOOLS_GROK_ACCOUNT names the account of a Grok caller", () => {
        const env = { GROK_SESSION_ID: "g1", [accountEnvVar("grok")]: "personal" };
        expect(whoIsCalling({ origin: "local", env }).account).toEqual({
            harness: "grok",
            account: "personal",
            proxyTarget: null,
        });
    });

    it("the model of a Codex caller, read from its rollout, is part of the one agent context", () => {
        const home = mkdtempSync(join(tmpdir(), "host-codex-"));
        const id = "01a0f4fc-171d-7c30-9679-ee00633dee2d";
        const dir = join(home, "sessions", "2026", "11", "04");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, `rollout-x-${id}.jsonl`),
            `${SafeJSON.stringify({ type: "turn_context", payload: { model: "codex-model-1" } })}\n`
        );
        const env = { CODEX_THREAD_ID: id, CODEX_HOME: home };
        expect(whoIsCalling({ origin: "local", env }, { facets: ["model"], now: NOW }).model).toBe("codex-model-1");
    });

    it("the model of a Grok caller, read from its summary.json, is part of the one agent context", () => {
        const home = mkdtempSync(join(tmpdir(), "host-grok-"));
        const dir = join(home, "sessions", encodeURIComponent("/fixture/repo"), "g1");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "updates.jsonl"), "");
        writeFileSync(join(dir, "summary.json"), SafeJSON.stringify({ current_model_id: "grok-model-1" }));
        const identity = whoIsCalling(
            { origin: "local", env: { GROK_SESSION_ID: "g1", GROK_HOME: home } },
            { facets: ["model"], overrides: { cwd: "/fixture/repo" } }
        );
        expect(identity.model).toBe("grok-model-1");
    });
});

describe("characterization: nested hosts inside T3 Code", () => {
    it.each([
        ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "claude-code"],
        ["CLAUDE_CODE_SESSION_ID", "GROK_SESSION_ID", "claude-code"],
        ["CLAUDE_CODE_SESSION_ID", "COPILOT_AGENT_SESSION_ID", "claude-code"],
        ["CODEX_THREAD_ID", "GROK_SESSION_ID", "codex"],
        ["CODEX_THREAD_ID", "COPILOT_AGENT_SESSION_ID", "codex"],
        ["GROK_SESSION_ID", "COPILOT_AGENT_SESSION_ID", "grok"],
    ] as const)("%s with %s keeps fixed precedence in either nesting order under T3", (firstKey, secondKey, agent) => {
        const t3 = { T3CODE_THREAD_ID: "thread:delegated-task:command%3Amcp%3Afixture" };
        expect(resolveAgentHost({ ...t3, [firstKey]: "outer-session", [secondKey]: "inner-session" })).toMatchObject({
            agent,
            sessionId: "outer-session",
        });
        expect(resolveAgentHost({ [secondKey]: "outer-session", [firstKey]: "inner-session", ...t3 })).toMatchObject({
            agent,
            sessionId: "inner-session",
        });
    });

    it.each([
        ["CLAUDE_CODE_SESSION_ID", "claude-code", false],
        ["CODEX_THREAD_ID", "codex", true],
        ["GROK_SESSION_ID", "grok", true],
        ["COPILOT_AGENT_SESSION_ID", "copilot", true],
    ] as const)("%s preserves punctuation and interior whitespace in an opaque session id", (key, agent, isInAgent) => {
        const id = "thread:child%3Amcp/part\\leaf ?#ž\tend";
        expect(resolveAgentHost({ [key]: id })).toMatchObject({ agent, sessionId: id, isInAgent });
        expect(agentSessionIds({ [key]: ` ${id} ` })).toEqual([{ agent, key, id }]);
    });
});

describe("characterization: blank host values in a nested environment", () => {
    it.each([
        ["CLAUDE_CODE_SESSION_ID", "", "CODEX_THREAD_ID", "codex", "fallback", true],
        ["CLAUDE_CODE_SESSION_ID", " \t\n ", "CODEX_THREAD_ID", "codex", "fallback", true],
        ["CLAUDECODE", "", "CODEX_THREAD_ID", "codex", "fallback", true],
        ["CLAUDECODE", " \t\n ", "CODEX_THREAD_ID", "claude-code", null, true],
        ["CODEX_THREAD_ID", "", "GROK_SESSION_ID", "grok", "fallback", true],
        ["CODEX_THREAD_ID", " \t\n ", "GROK_SESSION_ID", "grok", "fallback", true],
        ["CODEX_CI", "", "GROK_SESSION_ID", "grok", "fallback", true],
        ["CODEX_CI", " \t\n ", "GROK_SESSION_ID", "grok", "fallback", true],
        ["CODEX_CI", " 1 ", "GROK_SESSION_ID", "grok", "fallback", true],
        ["GROK_SESSION_ID", "", "COPILOT_AGENT_SESSION_ID", "copilot", "fallback", true],
        ["GROK_SESSION_ID", " \t\n ", "COPILOT_AGENT_SESSION_ID", "copilot", "fallback", true],
    ] as const)("%s=%j with %s resolves to %s", (key, value, fallbackKey, agent, sessionId, isInAgent) => {
        expect(resolveAgentHost({ [key]: value, [fallbackKey]: "fallback" })).toMatchObject({
            agent,
            sessionId,
            isInAgent,
        });
        expect(agentSessionIds({ [key]: value, [fallbackKey]: "fallback" })).toEqual([
            {
                agent:
                    fallbackKey === "CODEX_THREAD_ID"
                        ? "codex"
                        : fallbackKey === "GROK_SESSION_ID"
                          ? "grok"
                          : "copilot",
                key: fallbackKey,
                id: "fallback",
            },
        ]);
    });

    it.each(["", " \t\n "])("a blank Copilot id %j and T3 thread alone name no harness", (value) => {
        expect(resolveAgentHost({ COPILOT_AGENT_SESSION_ID: value, T3CODE_THREAD_ID: "t3-parent" })).toEqual({
            agent: "unknown",
            sessionId: null,
            isInAgent: false,
        });
        expect(agentSessionIds({ COPILOT_AGENT_SESSION_ID: value })).toEqual([]);
    });

    it.each(["", " \t\n "])("AI_AGENT=%j is retained verbatim except by Codex", (aiAgent) => {
        for (const host of [{ CLAUDECODE: "1" }, { GROK_SESSION_ID: "g1" }, { COPILOT_AGENT_SESSION_ID: "p1" }]) {
            expect(resolveAgentHost({ ...host, AI_AGENT: aiAgent }).aiAgent).toBe(aiAgent);
        }

        expect(resolveAgentHost({ CODEX_THREAD_ID: "x1", AI_AGENT: aiAgent }).aiAgent).toBeNull();
    });

    it.each(["", " \t\n "])("blank assigned keys %j do not hide a harness session", (value) => {
        const vars = { GENESIS_AGENTS_SESSION: value, GT_RENDEZVOUS_SESSION: value, CODEX_THREAD_ID: "thread-1" };
        expect(assignedSessionId(vars)).toBeNull();
        expect(resolveAgentHost(vars)).toMatchObject({ agent: "codex", sessionId: "thread-1" });
    });

    it("assigned and harness ids remain independent when both are set", () => {
        const vars = { GENESIS_AGENTS_SESSION: " swarm:parent/child ", CLAUDECODE: "1", CODEX_THREAD_ID: "inner" };
        expect(assignedSessionId(vars)).toBe("swarm:parent/child");
        expect(resolveAgentHost(vars)).toMatchObject({ agent: "claude-code", sessionId: null, isInAgent: true });
    });

    it("the T3 Code enricher keeps its host thread distinct from both nested harness session ids", () => {
        const env = { CLAUDE_CODE_SESSION_ID: "outer", CODEX_THREAD_ID: "inner", T3CODE_THREAD_ID: "t3-parent" };
        const identity = whoIsCalling({ origin: "local", env });
        expect(identity).toMatchObject({ agent: "claude-code", sessionId: "outer" });
        expect(identity.host?.threadId).toBe("t3-parent");
        expect([identity.sessionId, "inner"]).not.toContain(identity.host?.threadId);
    });
});
