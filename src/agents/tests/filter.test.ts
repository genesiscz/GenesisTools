import { describe, expect, test } from "bun:test";
import { filterForAgent, isVisibleToAgent } from "../lib/filter";
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
});
