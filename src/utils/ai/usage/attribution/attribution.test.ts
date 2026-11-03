import { describe, expect, test } from "bun:test";
import type { SessionPin } from "@genesiscz/utils/agent-sessions/pins";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import { claudeDriver, codexDriver } from "@genesiscz/utils/ai/usage/spend/drivers";
import type { CompactEvent } from "@genesiscz/utils/ai/usage/spend/events-cache";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import { attributeBar, riseSince } from "./bar";
import type { SessionAccountLookup, SessionRef } from "./session-account";
import { attributeEvents } from "./spend-share";
import { findRises, findSpikes, SPIKE_DEFAULTS } from "./spikes";

const WORK: AccountKey = { provider: "anthropic-sub", accountId: "acc-work", accountName: "work" };
const SHOP: AccountKey = { provider: "anthropic-sub", accountId: "acc-shop", accountName: "shop" };
const ROOT = "/fixture/projects/-repo";

function pin(sessionId: string, account: string | null): SessionPin {
    return { sessionId, account, model: null, cwd: "/repo", workspaceId: null, source: "hook", at: 1 };
}

const lookup: SessionAccountLookup = {
    directory: [WORK, SHOP],
    pins: new Map([
        ["lead-a", pin("lead-a", "work")],
        ["lead-b", pin("lead-b", "shop")],
    ]),
};

function event(file: string, t: string, costUsd: number, extra: Partial<CompactEvent> = {}): CompactEvent {
    return { id: `${file}:${t}`, t, costUsd, tokens: costUsd * 1000, source: "claude", file, ...extra };
}

function series(points: Array<[string, number]>, resets: string[] = []): SeriesEntry {
    return {
        provider: "anthropic-sub",
        account: "work",
        key: "five_hour",
        kind: "session",
        scopeModel: null,
        resets,
        availability: [],
        points: points.map(([t, percent]) => ({ t, percent, resetsAt: null, severity: null })),
    };
}

const report = (id: string) => `report ${id}`;

function sessionAccountOf(session: SessionRef, with_: SessionAccountLookup) {
    const driver = session.agent === "claude" ? claudeDriver : codexDriver;
    return driver.sessionAccount.accountOf(session, with_);
}

describe("session to account", () => {
    test("Claude reads the pin by the lead's id; a sub-agent's file names its lead; no pin is no account", () => {
        expect(claudeDriver.transcriptOwner(`${ROOT}/lead-a/subagents/agent-x1.jsonl`)).toEqual({
            sessionId: "x1",
            leadSessionId: "lead-a",
            subagent: true,
            project: "-repo",
        });
        expect(sessionAccountOf({ agent: "claude", sessionId: "lead-a", transcriptPath: "" }, lookup)).toEqual({
            account: WORK,
            basis: "pin",
            approximate: true,
        });
        expect(sessionAccountOf({ agent: "claude", sessionId: "nobody", transcriptPath: "" }, lookup).basis).toBe(
            "none"
        );
    });

    test("Codex: a bound home answers first; the shared home falls back to the pin", () => {
        const openai: AccountKey = { provider: "openai-sub", accountId: "acc-o", accountName: "side" };
        const withCodex = {
            ...lookup,
            directory: [...lookup.directory, openai],
            pins: new Map([["t1", pin("t1", "side")]]),
        };

        expect(
            sessionAccountOf({ agent: "codex", sessionId: "t0", transcriptPath: "", homeAccountId: "acc-o" }, withCodex)
                .basis
        ).toBe("home");
        expect(
            sessionAccountOf(
                { agent: "codex", sessionId: "t1", transcriptPath: "", homeAccountId: "(unbound)" },
                withCodex
            )
        ).toEqual({
            account: openai,
            basis: "pin",
            approximate: true,
        });
        const thread = "01a10953-2956-7180-8465-61f7415518c0";
        expect(
            codexDriver.transcriptOwner(`/h/sessions/2026/11/01/rollout-2026-11-01T10-00-00-${thread}.jsonl`).sessionId
        ).toBe(thread);
    });
});

describe("spikes", () => {
    test("a rise of 5 points within 10 minutes is one spike from its low to its peak; a reset is not a base", () => {
        const entry = series([
            ["2026-11-01T10:00:00Z", 10],
            ["2026-11-01T10:04:00Z", 13],
            ["2026-11-01T10:08:00Z", 17],
            ["2026-11-01T10:12:00Z", 19],
            ["2026-11-01T10:30:00Z", 2],
            ["2026-11-01T10:33:00Z", 4],
        ]);

        expect(findRises(entry, SPIKE_DEFAULTS)).toEqual([
            { from: { t: "2026-11-01T10:00:00Z", v: 10 }, to: { t: "2026-11-01T10:12:00Z", v: 19 } },
        ]);
    });

    test("the spike lists the account's sessions with main and sub-agent dollars, and unpinned spend apart", () => {
        const events = attributeEvents(
            [
                event(`${ROOT}/lead-a.jsonl`, "2026-11-01T10:05:00Z", 3),
                event(`${ROOT}/lead-a/subagents/agent-s1.jsonl`, "2026-11-01T10:06:00Z", 1),
                event(`${ROOT}/lead-b.jsonl`, "2026-11-01T10:06:00Z", 9),
                event(`${ROOT}/lone.jsonl`, "2026-11-01T10:07:00Z", 1),
                event(`${ROOT}/lead-a.jsonl`, "2026-11-01T12:00:00Z", 50),
            ],
            lookup
        );
        const [spike] = findSpikes({
            series: [
                series([
                    ["2026-11-01T10:00:00Z", 10],
                    ["2026-11-01T10:08:00Z", 18],
                ]),
            ],
            events,
            accountOf: () => WORK,
            settings: SPIKE_DEFAULTS,
            reportCommand: report,
        });

        expect(spike?.delta).toBe(8);
        expect(spike?.sessions.map((s) => [s.sessionId, s.mainUsd, s.subagentUsd, s.share, s.next])).toEqual([
            ["lead-a", 3, 1, 0.8, "report lead-a"],
        ]);
        expect(spike?.unattributed).toEqual({ costUsd: 1, tokens: 1000, share: 0.2 });
    });
});

describe("who ate the bar", () => {
    test("the rise since the last reset is split by project and session at the account's dollars per point", () => {
        const entry = series(
            [
                ["2026-11-01T08:00:00Z", 70],
                ["2026-11-01T09:00:00Z", 2],
                ["2026-11-01T10:00:00Z", 12],
                ["2026-11-01T11:00:00Z", 10],
                ["2026-11-01T12:00:00Z", 22],
            ],
            ["2026-11-01T09:00:00Z"]
        );
        const events = attributeEvents(
            [
                event(`${ROOT}/lead-a.jsonl`, "2026-11-01T07:00:00Z", 40),
                event(`${ROOT}/lead-a.jsonl`, "2026-11-01T09:30:00Z", 30),
                event(`${ROOT}/lead-a/subagents/agent-s1.jsonl`, "2026-11-01T11:30:00Z", 10),
            ],
            lookup
        );
        const bar = attributeBar({
            entry,
            account: WORK,
            events,
            from: new Date("2026-11-01T00:00:00Z"),
            now: new Date("2026-11-01T13:00:00Z"),
            reportCommand: report,
        });

        expect(riseSince(entry, Date.parse("2026-11-01T09:00:00Z"))).toBe(22);
        expect(bar.sinceReset).toBe(true);
        expect(bar.totalUsd).toBe(40);
        expect(bar.usdPerPercent).toBeCloseTo(40 / 22);
        expect(bar.projects).toEqual([{ project: "-repo", costUsd: 40, share: 1, barPercent: 22 }]);
    });
});
