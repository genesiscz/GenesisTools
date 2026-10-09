import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { appendFeed, readFeed } from "../lib/feed";
import { filterForAgent, isVisibleToAgent } from "../lib/filter";
import { announceLeave, leaveReasonOf, presentAgents, remainingAgentNames } from "../lib/leave";
import { ensureSessionDir, sessionPaths } from "../lib/paths";
import type { AgentRecord, FeedEvent } from "../lib/types";

const agentAlpha: AgentRecord = {
    agent_id: "agt_alpha",
    agent_name: "alpha",
    is_main: false,
    role: null,
    registered_at: "2026-01-01T00:00:00Z",

    logged_in_at: "2026-01-01T00:00:01Z",
    logged_out_at: null,
    mode: "stream",
    meta: {},
};

function msgEvent(overrides: Partial<FeedEvent> & { type: "message" }): FeedEvent {
    const base = {
        seq: 10,
        ts: "2026-01-01T00:00:10Z",
        type: "message",
        message_id: "0002",
        from_agent_id: "agt_beta",
        from_agent_name: "beta",
        to_agent_ids: ["agt_alpha"],
        body: "hi",
        meta: {},
        private: false,
    } as const;
    return { ...base, ...overrides } as FeedEvent;
}

describe("filter.isVisibleToAgent", () => {
    test("delivers direct messages", () => {
        const e = msgEvent({ type: "message", to_agent_ids: ["agt_alpha"] });
        expect(isVisibleToAgent(e, agentAlpha)).toBe(true);
    });

    test("delivers broadcasts", () => {
        const e = msgEvent({ type: "message", to_agent_ids: [] });
        expect(isVisibleToAgent(e, agentAlpha)).toBe(true);
    });

    test("does NOT deliver sender's own broadcast back to them", () => {
        const e = msgEvent({ type: "message", from_agent_id: "agt_alpha", to_agent_ids: [] });
        expect(isVisibleToAgent(e, agentAlpha)).toBe(false);
    });

    test("does NOT deliver sender's own direct message back to them", () => {
        const e = msgEvent({ type: "message", from_agent_id: "agt_alpha", to_agent_ids: ["agt_other"] });
        expect(isVisibleToAgent(e, agentAlpha)).toBe(false);
    });

    test("does not deliver messages addressed to someone else", () => {
        const e = msgEvent({ type: "message", to_agent_ids: ["agt_other"] });
        expect(isVisibleToAgent(e, agentAlpha)).toBe(false);
    });

    test("main agent sees peer-to-peer messages (orchestrator follow)", () => {
        const main: AgentRecord = { ...agentAlpha, agent_id: "main_x", agent_name: "lead", is_main: true };
        const e = msgEvent({ type: "message", to_agent_ids: ["agt_other"] });
        expect(isVisibleToAgent(e, main)).toBe(true);
    });

    test("main agent does not see its own sends", () => {
        const main: AgentRecord = { ...agentAlpha, agent_id: "main_x", agent_name: "lead", is_main: true };
        const e = msgEvent({ type: "message", from_agent_id: "main_x", to_agent_ids: ["agt_other"] });
        expect(isVisibleToAgent(e, main)).toBe(false);
    });

    test("delivers routed replies to the original sender", () => {
        const reply: FeedEvent = {
            seq: 11,
            ts: "2026-01-01T00:00:11Z",
            type: "message",
            message_id: "0003",
            from_agent_id: "agt_beta",
            from_agent_name: "beta",
            to_agent_ids: ["agt_alpha"],
            in_reply_to: "0001",
            body: "ack",
            meta: {},
            private: false,
        };
        expect(isVisibleToAgent(reply, agentAlpha)).toBe(true);
    });

    test("does not deliver reply to a message the agent did NOT send", () => {
        const reply: FeedEvent = {
            seq: 11,
            ts: "2026-01-01T00:00:11Z",
            type: "message",
            message_id: "0003",
            from_agent_id: "agt_beta",
            from_agent_name: "beta",
            to_agent_ids: ["agt_someone"],
            in_reply_to: "9999",
            body: "ack",
            meta: {},
            private: false,
        };
        expect(isVisibleToAgent(reply, agentAlpha)).toBe(false);
    });

    test("main agent sees stream-mode peer logged_in (no debug needed)", () => {
        const main: AgentRecord = { ...agentAlpha, agent_id: "main_x", agent_name: "lead", is_main: true };
        const loggedInStream: FeedEvent = {
            seq: 12,
            ts: "t",
            type: "logged_in",
            agent_id: "agt_beta",
            agent_name: "beta",
            mode: "stream",
        };
        const loggedInOnce: FeedEvent = {
            seq: 13,
            ts: "t",
            type: "logged_in",
            agent_id: "agt_beta",
            agent_name: "beta",
            mode: "once",
        };
        expect(isVisibleToAgent(loggedInStream, main)).toBe(true);
        expect(isVisibleToAgent(loggedInOnce, main)).toBe(false);
    });

    test("main agent sees real-failure peer logged_out (no debug needed)", () => {
        const main: AgentRecord = { ...agentAlpha, agent_id: "main_x", agent_name: "lead", is_main: true };
        const dead: FeedEvent = {
            seq: 12,
            ts: "t",
            type: "logged_out",
            agent_id: "agt_beta",
            reason: "dead_pid",
        };
        const clean: FeedEvent = {
            seq: 13,
            ts: "t",
            type: "logged_out",
            agent_id: "agt_beta",
            reason: "clean_exit",
        };
        expect(isVisibleToAgent(dead, main)).toBe(true);
        expect(isVisibleToAgent(clean, main)).toBe(false);
    });

    test("hides all peer lifecycle events by default for non-main agents (debug off)", () => {
        const loggedIn: FeedEvent = {
            seq: 12,
            ts: "2026-01-01T00:00:12Z",
            type: "logged_in",
            agent_id: "agt_beta",
            agent_name: "beta",
            mode: "stream",
        };
        const loggedOutDead: FeedEvent = {
            seq: 13,
            ts: "2026-01-01T00:00:13Z",
            type: "logged_out",
            agent_id: "agt_beta",
            reason: "dead_pid",
        };
        const loggedOutClean: FeedEvent = {
            seq: 14,
            ts: "2026-01-01T00:00:14Z",
            type: "logged_out",
            agent_id: "agt_beta",
            reason: "clean_exit",
        };
        expect(isVisibleToAgent(loggedIn, agentAlpha)).toBe(false);
        expect(isVisibleToAgent(loggedOutDead, agentAlpha)).toBe(false);
        expect(isVisibleToAgent(loggedOutClean, agentAlpha)).toBe(false);
    });

    test("shows all peer lifecycle events when session debug is on", () => {
        const loggedIn: FeedEvent = {
            seq: 12,
            ts: "2026-01-01T00:00:12Z",
            type: "logged_in",
            agent_id: "agt_beta",
            agent_name: "beta",
            mode: "stream",
        };
        const loggedOutDead: FeedEvent = {
            seq: 13,
            ts: "2026-01-01T00:00:13Z",
            type: "logged_out",
            agent_id: "agt_beta",
            reason: "dead_pid",
        };
        expect(isVisibleToAgent(loggedIn, agentAlpha, { debug: true })).toBe(true);
        expect(isVisibleToAgent(loggedOutDead, agentAlpha, { debug: true })).toBe(true);
    });

    test("never shows own lifecycle events even with debug on", () => {
        const loggedIn: FeedEvent = {
            seq: 12,
            ts: "2026-01-01T00:00:12Z",
            type: "logged_in",
            agent_id: "agt_alpha",
            agent_name: "alpha",
            mode: "stream",
        };
        expect(isVisibleToAgent(loggedIn, agentAlpha, { debug: true })).toBe(false);
    });

    test("hides peer --once login/logout churn even when session debug is on", () => {
        const onceLoggedIn: FeedEvent = {
            seq: 12,
            ts: "2026-01-01T00:00:12Z",
            type: "logged_in",
            agent_id: "agt_beta",
            agent_name: "beta",
            mode: "once",
        };
        const onceLoggedOut: FeedEvent = {
            seq: 13,
            ts: "2026-01-01T00:00:13Z",
            type: "logged_out",
            agent_id: "agt_beta",
            reason: "clean_exit",
            mode: "once",
        };
        expect(isVisibleToAgent(onceLoggedIn, agentAlpha, { debug: true })).toBe(false);
        expect(isVisibleToAgent(onceLoggedOut, agentAlpha, { debug: true })).toBe(false);

        const main: AgentRecord = { ...agentAlpha, agent_id: "main_x", agent_name: "lead", is_main: true };
        expect(isVisibleToAgent(onceLoggedIn, main, { debug: true })).toBe(false);
        expect(isVisibleToAgent(onceLoggedOut, main, { debug: true })).toBe(false);
    });
});

describe("filter.filterForAgent", () => {
    test("excludes own sends and other-target directs; keeps own-target + broadcasts from others", () => {
        const events: FeedEvent[] = [
            msgEvent({ type: "message", to_agent_ids: ["agt_alpha"] }),
            msgEvent({ type: "message", from_agent_id: "agt_alpha", to_agent_ids: [] }),
            msgEvent({ type: "message", to_agent_ids: [] }),
            msgEvent({ type: "message", to_agent_ids: ["agt_other"] }),
        ];
        const result = filterForAgent(events, agentAlpha);
        expect(result.length).toBe(2);
    });

    test("main keeps peer-to-peer directs and drops its own sends", () => {
        const main: AgentRecord = { ...agentAlpha, agent_id: "main_x", agent_name: "lead", is_main: true };
        const events: FeedEvent[] = [
            msgEvent({ type: "message", to_agent_ids: ["agt_other"] }),
            msgEvent({ type: "message", from_agent_id: "main_x", to_agent_ids: ["agt_other"] }),
        ];
        const result = filterForAgent(events, main);
        expect(result.length).toBe(1);
        expect(result[0]?.type === "message" && result[0].to_agent_ids).toEqual(["agt_other"]);
    });
});

describe("agent_left", () => {
    const loggedIn = (seq: number, id: string, name: string, loginId?: string): FeedEvent => ({
        seq,
        ts: "2026-01-01T00:00:01Z",
        type: "logged_in",
        agent_id: id,
        agent_name: name,
        mode: "once",
        ...(loginId ? { login_id: loginId } : {}),
    });
    const left = (seq: number, id: string, name: string, loginId?: string): FeedEvent => ({
        seq,
        ts: "2026-01-01T00:00:02Z",
        type: "agent_left",
        agent_id: id,
        agent_name: name,
        reason: "leave",
        remaining: [],
        ...(loginId ? { login_id: loginId } : {}),
    });

    test("reaches every agent but the leaver, a --once receiver included", () => {
        expect(isVisibleToAgent(left(5, "agt_beta", "beta"), agentAlpha)).toBe(true);
        expect(isVisibleToAgent(left(5, "agt_alpha", "alpha"), agentAlpha)).toBe(false);
    });

    test("remaining agents are those that logged in and did not leave since; a --once logout is not leaving", () => {
        const events: FeedEvent[] = [
            loggedIn(1, "agt_alpha", "alpha"),
            loggedIn(2, "agt_beta", "beta"),
            {
                seq: 3,
                ts: "2026-01-01T00:00:03Z",
                type: "logged_out",
                agent_id: "agt_beta",
                reason: "clean_exit",
                mode: "once",
            },
            loggedIn(4, "agt_gamma", "gamma"),
            left(5, "agt_gamma", "gamma"),
        ];

        expect(remainingAgentNames(events, "agt_alpha")).toEqual(["beta"]);
        // A join is announced only for an agent that is not present: beta's next --once login is silent,
        // gamma's next login after leaving is a new join.
        expect(presentAgents(events).has("agt_beta")).toBe(true);
        expect(presentAgents(events).has("agt_gamma")).toBe(false);
        expect(leaveReasonOf("once", "clean_exit")).toBeNull();
        expect(leaveReasonOf("once", "signal")).toBe("signal");
        expect(leaveReasonOf("stream", "cap")).toBe("cap");
        // A stream login that stopped on its own (its watch failed) leaves nobody listening either.
        expect(leaveReasonOf("stream", "clean_exit")).toBe("ended");
    });

    test("a leave that names an older login does not take the agent's newer login off the bus", () => {
        // The old listener released its slot, the replacement logged in, then the old listener's leave landed.
        const events: FeedEvent[] = [
            loggedIn(1, "agt_alpha", "alpha", "login-old"),
            loggedIn(2, "agt_beta", "beta"),
            loggedIn(3, "agt_alpha", "alpha", "login-new"),
            left(4, "agt_alpha", "alpha", "login-old"),
        ];

        expect(presentAgents(events).has("agt_alpha")).toBe(true);
        expect(remainingAgentNames(events, "agt_beta")).toEqual(["alpha"]);
        // The current login's own leave, and a manual leave with no login id, still end it.
        expect(presentAgents([...events, left(5, "agt_alpha", "alpha", "login-new")]).has("agt_alpha")).toBe(false);
        expect(presentAgents([...events, left(5, "agt_alpha", "alpha")]).has("agt_alpha")).toBe(false);
    });

    test("announceLeave writes no agent_left for a login that a newer one replaced, and writes it for the current one", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-leave-generation-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("leave-generation");
            ensureSessionDir(paths);
            await appendFeed(paths, {
                type: "logged_in",
                agent_id: "agt_alpha",
                agent_name: "alpha",
                mode: "stream",
                login_id: "login-old",
            });
            await appendFeed(paths, {
                type: "logged_in",
                agent_id: "agt_alpha",
                agent_name: "alpha",
                mode: "stream",
                login_id: "login-new",
            });

            const stale = await announceLeave(paths, {
                agent_id: "agt_alpha",
                agent_name: "alpha",
                reason: "signal",
                login_id: "login-old",
            });
            expect(stale).toBeNull();
            expect((await readFeed(paths)).some((event) => event.type === "agent_left")).toBe(false);

            const current = await announceLeave(paths, {
                agent_id: "agt_alpha",
                agent_name: "alpha",
                reason: "signal",
                login_id: "login-new",
            });
            expect(current).toMatchObject({ type: "agent_left", login_id: "login-new" });
            expect(presentAgents(await readFeed(paths)).has("agt_alpha")).toBe(false);
        });
    });
});
