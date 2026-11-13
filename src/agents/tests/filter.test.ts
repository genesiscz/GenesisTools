import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { appendFeed, readFeed } from "../lib/feed";
import { filterForAgent, isVisibleToAgent, presenceModeFor } from "../lib/filter";
import {
    announceDueLapses,
    announceLapses,
    announceLeave,
    foldRearms,
    leaveReasonOf,
    logInAndAnnounceJoin,
    notListening,
    pendingRearms,
    presentAgents,
    REARM_GRACE_MS,
    remainingAgentNames,
} from "../lib/leave";
import { ensureSessionDir, sessionPaths } from "../lib/paths";
import type { AgentRecord, FeedEvent } from "../lib/types";

const agentAlpha: AgentRecord = {
    agent_id: "agt_alpha",
    agent_name: "alpha",
    is_main: false,
    role: null,
    registered_at: "2026-01-01T00:00:00Z",
    registered_seq: 0,
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

    test("main gets no peer logged_in: agent_joined reports a real arrival, and a re-arm is not news", () => {
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
        expect(isVisibleToAgent(loggedInStream, main)).toBe(false);
        expect(isVisibleToAgent(loggedInOnce, main)).toBe(false);
        expect(isVisibleToAgent(loggedInStream, main, { debug: true })).toBe(true);
    });

    test("main agent sees real-failure peer logged_out, not a re-arm (no debug needed)", () => {
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
        const rearm: FeedEvent = { ...dead, seq: 14, reason: "signal", rearm_until: "t" } as FeedEvent;
        expect(isVisibleToAgent(dead, main)).toBe(true);
        expect(isVisibleToAgent(clean, main)).toBe(false);
        // A lapse after the grace reports a failed re-arm; the logout itself is not news.
        expect(isVisibleToAgent(rearm, main)).toBe(false);
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

    test("reaches main by default, another agent only with --presence, and never the leaver", () => {
        const main: AgentRecord = { ...agentAlpha, agent_id: "main_lead", agent_name: "lead", is_main: true };

        expect(isVisibleToAgent(left(5, "agt_beta", "beta"), main)).toBe(true);
        // A child gets no presence by default: 28% of the child turns in the 2026-11-08 swarm woke only on it.
        expect(isVisibleToAgent(left(5, "agt_beta", "beta"), agentAlpha)).toBe(false);
        expect(isVisibleToAgent(left(5, "agt_beta", "beta"), agentAlpha, undefined, { presence: "changes" })).toBe(
            true
        );
        expect(isVisibleToAgent(left(5, "agt_alpha", "alpha"), agentAlpha, undefined, { presence: "all" })).toBe(false);
        expect(isVisibleToAgent(left(5, "agt_beta", "beta"), main, undefined, { presence: "none" })).toBe(false);
    });

    test("presence defaults: debug session all, main changes, others none; an explicit mode wins", () => {
        const main: AgentRecord = { ...agentAlpha, is_main: true };

        expect(presenceModeFor(agentAlpha)).toBe("none");
        expect(presenceModeFor(main)).toBe("changes");
        expect(presenceModeFor(agentAlpha, { debug: true })).toBe("all");
        expect(presenceModeFor(main, { debug: true }, "none")).toBe("none");
    });

    test("changes hides the re-arm leaves an older writer posted; all shows them", () => {
        const rearmLeave: FeedEvent = { ...left(5, "agt_beta", "beta"), reason: "signal" } as FeedEvent;
        const lapsed: FeedEvent = { ...left(6, "agt_beta", "beta"), reason: "lapsed" } as FeedEvent;
        const changes = { presence: "changes" as const };

        expect(isVisibleToAgent(rearmLeave, agentAlpha, undefined, changes)).toBe(false);
        expect(isVisibleToAgent(lapsed, agentAlpha, undefined, changes)).toBe(true);
        expect(isVisibleToAgent(rearmLeave, agentAlpha, undefined, { presence: "all" })).toBe(true);
    });

    test("presence is ordered by feed seq: a peer event in the registration's millisecond but after it is news", () => {
        // Registered at seq 7; the peer events share its timestamp to the millisecond.
        const registered: AgentRecord = {
            ...agentAlpha,
            is_main: true,
            registered_at: "2026-01-01T00:00:02Z",
            registered_seq: 7,
        };
        const at = (seq: number, event: FeedEvent): FeedEvent => ({ ...event, seq, ts: registered.registered_at });

        expect(isVisibleToAgent(at(8, left(0, "agt_beta", "beta")), registered)).toBe(true);
        expect(isVisibleToAgent(at(6, left(0, "agt_beta", "beta")), registered)).toBe(false);
        expect(isVisibleToAgent(at(7, left(0, "agt_beta", "beta")), registered)).toBe(false);
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
        // A killed login is a re-arm: its logged_out carries a grace, and only a lapse after it is a leave.
        expect(leaveReasonOf("once", "signal")).toBeNull();
        expect(leaveReasonOf("stream", "signal")).toBeNull();
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

            // A second leave (a repeated `tools agents leave`, or one after a --once timeout) announces nothing.
            const again = await announceLeave(paths, { agent_id: "agt_alpha", agent_name: "alpha", reason: "leave" });
            expect(again).toBeNull();
            expect((await readFeed(paths)).filter((event) => event.type === "agent_left")).toHaveLength(1);
            // Nor does a leave of an agent that never logged in.
            expect(
                await announceLeave(paths, { agent_id: "agt_ghost", agent_name: "ghost", reason: "leave" })
            ).toBeNull();
        });
    });

    test("a replacement login announces its join whenever the old login's leave landed before its logged_in", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-join-race-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            for (const [round, order] of ["leave-first", "login-first", "together"].entries()) {
                const paths = sessionPaths(`join-race-${round}`);
                ensureSessionDir(paths);
                await logInAndAnnounceJoin(paths, {
                    agent_id: "agt_alpha",
                    agent_name: "alpha",
                    mode: "stream",
                    login_id: "old",
                });
                const leave = () =>
                    announceLeave(paths, {
                        agent_id: "agt_alpha",
                        agent_name: "alpha",
                        reason: "signal",
                        login_id: "old",
                    });
                const login = () =>
                    logInAndAnnounceJoin(paths, {
                        agent_id: "agt_alpha",
                        agent_name: "alpha",
                        mode: "stream",
                        login_id: "new",
                    });

                if (order === "leave-first") {
                    await leave();
                    await login();
                } else if (order === "login-first") {
                    await login();
                    await leave();
                } else {
                    await Promise.all([leave(), login()]);
                }

                const events = await readFeed(paths);
                const newLogin = events.findIndex((event) => event.type === "logged_in" && event.login_id === "new");
                const leftBefore = events
                    .slice(0, newLogin)
                    .some((event) => event.type === "agent_left" && event.agent_id === "agt_alpha");
                const joinedAfter = events
                    .slice(newLogin + 1)
                    .some((event) => event.type === "agent_joined" && event.agent_id === "agt_alpha");

                expect({ order, present: presentAgents(events).has("agt_alpha") }).toEqual({ order, present: true });
                // Peers that were told alpha left are told it is back.
                expect({ order, joinedAfter }).toEqual({ order, joinedAfter: leftBefore });
            }
        });
    });
    test("a re-arm inside the grace is silent; without a new login one lapsed leave follows, written once", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-rearm-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("rearm");
            ensureSessionDir(paths);
            const login = (agentId: string, name: string, loginId: string) =>
                logInAndAnnounceJoin(paths, { agent_id: agentId, agent_name: name, mode: "stream", login_id: loginId });
            const killed = (agentId: string, loginId: string, until: number) =>
                appendFeed(paths, {
                    type: "logged_out",
                    agent_id: agentId,
                    reason: "signal",
                    mode: "stream",
                    login_id: loginId,
                    rearm_until: new Date(until).toISOString(),
                });
            const now = Date.now();

            await login("main_lead", "lead", "lead-1");
            await login("agt_beta", "beta", "beta-1");
            await login("agt_gamma", "gamma", "gamma-1");

            // beta's Monitor expires and is re-armed inside the grace: no presence event at all.
            await killed("agt_beta", "beta-1", now + REARM_GRACE_MS);
            expect(notListening(await readFeed(paths), ["agt_beta"])).toMatchObject([{ state: "rearming" }]);
            expect(await login("agt_beta", "beta", "beta-2")).toEqual({ joined: false });
            expect(pendingRearms(await readFeed(paths)).size).toBe(0);

            // gamma's is not re-armed: nothing before the grace ends, one lapsed leave after it.
            await killed("agt_gamma", "gamma-1", now + REARM_GRACE_MS);
            expect(await announceLapses(paths, now + REARM_GRACE_MS - 1)).toEqual([]);
            const lapsed = await announceLapses(paths, now + REARM_GRACE_MS);
            expect(lapsed).toMatchObject([
                { type: "agent_left", agent_id: "agt_gamma", reason: "lapsed", login_id: "gamma-1" },
            ]);
            expect(lapsed[0]?.type === "agent_left" && lapsed[0].remaining.sort()).toEqual(["beta", "lead"]);
            expect(await announceLapses(paths, now + REARM_GRACE_MS * 2)).toEqual([]);
            expect(notListening(await readFeed(paths), ["agt_gamma", "agt_ghost"])).toMatchObject([
                { agent_id: "agt_gamma", state: "left", reason: "lapsed" },
                { agent_id: "agt_ghost", state: "never_logged_in" },
            ]);

            // Its late re-arm is a join again.
            expect(await login("agt_gamma", "gamma", "gamma-2")).toEqual({ joined: true });

            const presenceEvents = (await readFeed(paths)).filter(
                (event) => event.type === "agent_left" || event.type === "agent_joined"
            );
            expect(presenceEvents.map((event) => `${event.type}:${event.agent_id}`)).toEqual([
                "agent_joined:main_lead",
                "agent_joined:agt_beta",
                "agent_joined:agt_gamma",
                "agent_left:agt_gamma",
                "agent_joined:agt_gamma",
            ]);
        });
    });

    test("an agent that leaves on purpose during its grace does not lapse later", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-rearm-leave-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("rearm-leave");
            ensureSessionDir(paths);
            const now = Date.now();
            await logInAndAnnounceJoin(paths, {
                agent_id: "agt_beta",
                agent_name: "beta",
                mode: "stream",
                login_id: "beta-1",
            });
            await announceLeave(paths, { agent_id: "agt_beta", agent_name: "beta", reason: "leave", note: "done" });
            // The Monitor it stops afterwards still writes its logged_out with a grace.
            await appendFeed(paths, {
                type: "logged_out",
                agent_id: "agt_beta",
                reason: "signal",
                mode: "stream",
                login_id: "beta-1",
                rearm_until: new Date(now).toISOString(),
            });

            expect(await announceLapses(paths, now + REARM_GRACE_MS)).toEqual([]);
            expect((await readFeed(paths)).filter((event) => event.type === "agent_left")).toHaveLength(1);
        });
    });

    test("a late logout of an older login does not take the current login's re-arm away", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-rearm-late-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("rearm-late");
            ensureSessionDir(paths);
            const now = Date.now();
            const killed = (loginId: string) =>
                appendFeed(paths, {
                    type: "logged_out",
                    agent_id: "agt_beta",
                    reason: "signal",
                    mode: "stream",
                    login_id: loginId,
                    rearm_until: new Date(now).toISOString(),
                });
            const login = (loginId: string) =>
                logInAndAnnounceJoin(paths, {
                    agent_id: "agt_beta",
                    agent_name: "beta",
                    mode: "stream",
                    login_id: loginId,
                });

            // Login A released its slot before writing its logout, so B logged in and out first.
            await login("beta-a");
            await login("beta-b");
            await killed("beta-b");
            await killed("beta-a");
            // A leave that names the older login does not end B either.
            await appendFeed(paths, {
                type: "agent_left",
                agent_id: "agt_beta",
                agent_name: "beta",
                reason: "ended",
                remaining: [],
                login_id: "beta-a",
            });

            const feed = await readFeed(paths);
            expect(foldRearms(feed).pending.get("agt_beta")?.loginId).toBe("beta-b");
            expect(pendingRearms(feed).get("agt_beta")?.loginId).toBe("beta-b");
            expect(await announceLapses(paths, now + REARM_GRACE_MS)).toMatchObject([
                { type: "agent_left", agent_id: "agt_beta", reason: "lapsed", login_id: "beta-b" },
            ]);
        });
    });

    test("a lapse check forgets only the re-arms due at its own cutoff, and not one replaced meanwhile", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-rearm-cutoff-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("rearm-cutoff");
            ensureSessionDir(paths);
            // In the past, so a check that took a fresh time after the lock would call every entry below due.
            const cutoff = Date.now() - 60_000;
            const killed = (agentId: string, loginId: string, until: number) =>
                appendFeed(paths, {
                    type: "logged_out",
                    agent_id: agentId,
                    reason: "signal",
                    mode: "stream",
                    login_id: loginId,
                    rearm_until: new Date(until).toISOString(),
                });

            for (const name of ["beta", "gamma", "delta"]) {
                await logInAndAnnounceJoin(paths, {
                    agent_id: `agt_${name}`,
                    agent_name: name,
                    mode: "stream",
                    login_id: `${name}-1`,
                });
            }

            await killed("agt_beta", "beta-1", cutoff);
            // Falls due while the check waits for the feed lock: not announced by it, so it must stay.
            await killed("agt_gamma", "gamma-1", cutoff + 1);
            await killed("agt_delta", "delta-1", cutoff);

            const fold = foldRearms(await readFeed(paths));
            const check = announceDueLapses(paths, fold, cutoff);
            // While the check waits, delta's next login ends too: the watcher folds a newer re-arm in its place.
            const replaced = {
                loginId: "delta-2",
                since: new Date(cutoff).toISOString(),
                until: new Date(cutoff + 1_000).toISOString(),
            };
            fold.pending.set("agt_delta", replaced);
            const lapsed = await check;

            expect(lapsed.map((event) => event.type === "agent_left" && event.agent_id).sort()).toEqual([
                "agt_beta",
                "agt_delta",
            ]);
            expect([...fold.pending.keys()].sort()).toEqual(["agt_delta", "agt_gamma"]);
            expect(fold.pending.get("agt_delta")).toBe(replaced);
        });
    });
});
