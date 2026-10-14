import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type AgentNames,
    agentNamesFrom,
    eventJsonLine,
    formatEventMonitor,
    type MonitorEvent,
} from "../lib/format-monitor";
import { formatReadyEvent, resolveFeedFormat } from "../lib/login-io";
import type { AgentRecord, FeedEvent, MessageEvent } from "../lib/types";

describe("formatReadyEvent", () => {
    test("emits a stdout-only ready envelope for the attached agent", () => {
        const record: AgentRecord = {
            agent_id: "main_demo",
            agent_name: "lead",
            is_main: true,
            role: null,
            registered_at: "t",
            registered_seq: 0,
            logged_in_at: "t",
            logged_out_at: null,
            mode: "stream",
            meta: {},
        };

        expect(formatReadyEvent(record, "demo-session", "stream")).toEqual({
            type: "ready",
            agent_id: "main_demo",
            agent_name: "lead",
            session: "demo-session",
            mode: "stream",
            is_main: true,
        });
    });
});

describe("resolveFeedFormat", () => {
    test("a pipe gets monitor and a terminal gets the command's default", () => {
        expect(resolveFeedFormat({ format: undefined, terminalDefault: "json", stdoutIsTTY: false })).toBe("monitor");
        expect(resolveFeedFormat({ format: undefined, terminalDefault: "json", stdoutIsTTY: true })).toBe("json");
        expect(resolveFeedFormat({ format: undefined, terminalDefault: "pretty", stdoutIsTTY: true })).toBe("pretty");
    });

    test("an explicit format wins and an unknown one is refused", () => {
        expect(resolveFeedFormat({ format: "json", terminalDefault: "json", stdoutIsTTY: false })).toBe("json");
        expect(resolveFeedFormat({ format: "pretty", terminalDefault: "json", stdoutIsTTY: false })).toBe("pretty");
        expect(resolveFeedFormat({ format: "monitor", terminalDefault: "json", stdoutIsTTY: true })).toBe("monitor");
        expect(() => resolveFeedFormat({ format: "yaml", terminalDefault: "json", stdoutIsTTY: false })).toThrow(
            'unknown --format "yaml"'
        );
    });
});

describe("formatEventMonitor", () => {
    const ts = "2026-10-13T16:00:00.000Z";
    const message: MessageEvent = {
        seq: 9,
        ts,
        type: "message",
        message_id: "m_0001",
        from_agent_id: "agt_0002",
        from_agent_name: "beta",
        to_agent_ids: ["main_demo"],
        body: "Acknowledged. Reading the files now.",
        meta: {},
        private: false,
    };
    const names: AgentNames = new Map([
        ["main_demo", "lead"],
        ["agt_0001", "alpha"],
        ["agt_0002", "beta"],
    ]);

    const cases: Array<[MonitorEvent, string]> = [
        [message, "message: beta → lead: Acknowledged. Reading the files now."],
        [
            { ...message, to_agent_ids: [], private: true, body: "all hands" },
            "message: beta → (broadcast) (private): all hands",
        ],
        [
            { ...message, to_agent_ids: ["agt_0001", "agt_0009"], body: "  " },
            "message: beta → alpha, agt_0009: (empty body)",
        ],
        [{ ...message, in_reply_to: "m_0000", body: "done" }, "reply: beta → lead, re m_0000: done"],
        [{ ...message, in_reply_to: "m_0000", body: "" }, "ack: beta → lead, re m_0000"],
        [
            {
                type: "ready",
                agent_id: "main_demo",
                agent_name: "lead",
                session: "demo",
                mode: "stream",
                is_main: true,
            },
            "ready: lead is listening (stream, main) · session demo",
        ],
        [
            { type: "timeout", agent_name: "beta", session: "demo", waited_ms: 1500 },
            "timeout: no mail for beta after 1.5s",
        ],
        [
            { seq: 3, ts, type: "agent_joined", agent_id: "agt_0002", agent_name: "beta", present: ["lead", "alpha"] },
            "joined: beta · present: lead, alpha",
        ],
        [
            {
                seq: 4,
                ts,
                type: "agent_left",
                agent_id: "agt_0002",
                agent_name: "beta",
                reason: "timeout",
                remaining: [],
                note: "line one\nline two",
            },
            "left: beta (timeout: line one ⏎ line two) · remaining: nobody",
        ],
        [
            {
                seq: 1,
                ts,
                type: "registered",
                agent_name: "lead",
                agent_id: "main_demo",
                awaiting_login: false,
                is_main: true,
                role: "planner",
                meta: {},
            },
            "registered: lead as main_demo (main, role planner)",
        ],
        [
            { seq: 2, ts, type: "logged_in", agent_id: "agt_0001", agent_name: "alpha", mode: "once" },
            "logged in: alpha (once)",
        ],
        [{ seq: 5, ts, type: "logged_out", agent_id: "agt_0001", reason: "cap" }, "logged out: alpha (cap)"],
        [
            { seq: 6, ts, type: "stale_lock_reaped", lock: "agt_0001.login", pid: 4242, reason: "dead_pid" },
            "stale lock reaped: agt_0001.login (dead_pid, pid 4242)",
        ],
    ];

    test.each(cases)("%# headline, then the exact --format json line", (event, headline) => {
        const lines = formatEventMonitor(event, names).split("\n");

        expect(lines).toEqual([headline, eventJsonLine(event)]);
        expect(SafeJSON.parse(lines[1] ?? "", { strict: true })).toEqual(event);
        expect(lines[0]?.startsWith("{")).toBe(false);
    });

    test("a message's JSON line leads with body, then from_agent_name, then the other keys in their usual order", () => {
        const reply: MessageEvent = { ...message, in_reply_to: "0001" };
        const keys = Object.keys(SafeJSON.parse(eventJsonLine(reply), { strict: true }) as Record<string, unknown>);
        const [, json] = formatEventMonitor(reply, names).split("\n");

        expect(keys.slice(0, 2)).toEqual(["body", "from_agent_name"]);
        expect(keys.slice(2)).toEqual(Object.keys(reply).filter((key) => key !== "body" && key !== "from_agent_name"));
        expect(json).toStartWith(`{"body":${SafeJSON.stringify(reply.body)},"from_agent_name":"beta",`);
    });

    test("every other event keeps its key order", () => {
        const joined: FeedEvent = {
            seq: 9,
            ts,
            type: "agent_joined",
            agent_id: "agt_0002",
            agent_name: "beta",
            present: [],
        };

        expect(eventJsonLine(joined)).toBe(SafeJSON.stringify(joined, { strict: true }));
    });

    test("a long multi-line body stays on one headline line, and the JSON line keeps every byte", () => {
        const body = `first line\r\nsecond\tline\u001b[31m\n${"x".repeat(400)}`;
        const [headline, json, ...rest] = formatEventMonitor({ ...message, body }, names).split("\n");

        expect(rest).toEqual([]);
        expect(headline).toStartWith("message: beta → lead: first line ⏎ second line [31m ⏎ xxx");
        expect(headline).toEndWith("...");
        expect(headline?.length).toBeLessThan(260);
        expect(SafeJSON.parse(json ?? "", { strict: true })).toEqual({ ...message, body });
    });

    const metadataCases: Array<[MonitorEvent, string]> = [
        [
            {
                ...message,
                from_agent_name: "beta\nworker",
                to_agent_ids: ["main_demo", "unknown\rid"],
                in_reply_to: "m_\t0",
            },
            "reply: beta ⏎ worker → lead [31m, unknown ⏎ id, re m_ 0: Acknowledged. Reading the files now.",
        ],
        [
            {
                type: "ready",
                agent_id: "main_demo",
                agent_name: "lead\u001b[0m",
                session: "demo\r\nsession\u2028next\u2029last",
                mode: "stream",
                is_main: true,
            },
            "ready: lead [0m is listening (stream, main) · session demo ⏎ session ⏎ next ⏎ last",
        ],
        [
            {
                seq: 1,
                ts,
                type: "registered",
                agent_name: "alpha\nworker",
                agent_id: "agt_\u009b31m",
                awaiting_login: true,
                is_main: false,
                role: "reviewer\u0000\trole",
                meta: {},
            },
            "registered: alpha ⏎ worker as agt_ 31m (role reviewer  role, awaiting login)",
        ],
    ];

    test.each(metadataCases)("%# sanitizes all headline metadata without changing the JSON", (event, headline) => {
        const unsafeNames: AgentNames = new Map([["main_demo", "lead\u001b[31m"]]);

        for (const position of [undefined, { index: 2, total: 3 }]) {
            const lines = formatEventMonitor(event, unsafeNames, position).split("\n");

            expect(lines).toEqual([`${position ? "[2/3] " : ""}${headline}`, eventJsonLine(event)]);
            expect(lines[0]).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
            expect(SafeJSON.parse(lines[1] ?? "", { strict: true })).toEqual(event);
        }

        expect(unsafeNames.get("main_demo")).toBe("lead\u001b[31m");
    });

    test("events written together number themselves, a single one does not", () => {
        expect(formatEventMonitor(message, names, { index: 2, total: 3 })).toStartWith("[2/3] message: beta → lead:");
        expect(formatEventMonitor(message, names, { index: 1, total: 1 })).toStartWith("message: beta → lead:");
    });

    test("names come from the feed, so recipients read as names", () => {
        const feed: FeedEvent[] = [
            {
                seq: 1,
                ts,
                type: "registered",
                agent_name: "lead",
                agent_id: "main_demo",
                awaiting_login: false,
                is_main: true,
                role: null,
                meta: {},
            },
            { seq: 2, ts, type: "logged_in", agent_id: "agt_0002", agent_name: "beta", mode: "stream" },
        ];

        expect(formatEventMonitor(message, agentNamesFrom(feed)).split("\n")[0]).toBe(
            "message: beta → lead: Acknowledged. Reading the files now."
        );
        expect(formatEventMonitor(message, new Map()).split("\n")[0]).toBe(
            "message: beta → main_demo: Acknowledged. Reading the files now."
        );
    });
});
