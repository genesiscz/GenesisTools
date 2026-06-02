import { describe, expect, test } from "bun:test";
import { buildAttentionItems, isAgentCommand } from "@app/dev-dashboard/lib/attention/aggregator";
import type { QaRow } from "@app/question/lib/read-model";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

// Fixed "now" — 2026-06-02 12:00 local. startOfDay = same date 00:00 local.
const NOW = new Date(2026, 5, 2, 12, 0, 0, 0).getTime();
const TODAY_AM = new Date(2026, 5, 2, 9, 0, 0, 0).getTime();
const TODAY_EARLIER = new Date(2026, 5, 2, 8, 0, 0, 0).getTime();
const YESTERDAY = new Date(2026, 5, 1, 23, 0, 0, 0).getTime();

function qaRow(over: Partial<QaRow> & Pick<QaRow, "id" | "ts" | "tag">): QaRow {
    return {
        sessionId: "s1",
        sessionTitle: null,
        project: "GenesisTools",
        repoRoot: "/repo",
        cwd: "/repo",
        branch: null,
        commitSha: null,
        commitMessage: null,
        agent: "claude-code",
        isWorktree: false,
        worktreePath: null,
        aiAgent: null,
        agentLabel: null,
        question: "Q?",
        answerMd: "A",
        refs: [],
        source: "mcp",
        turnUuid: null,
        supersededBy: null,
        readAt: null,
        ...over,
    };
}

function ttyd(over: Partial<TtydSession> & Pick<TtydSession, "id">): TtydSession {
    return {
        port: 7000,
        command: "zsh",
        cwd: "/Users/me/project",
        pid: 1234,
        startedAt: new Date(TODAY_AM).toISOString(),
        ...over,
    };
}

describe("isAgentCommand", () => {
    test("recognizes agent CLIs and rejects shells/editors/empties", () => {
        expect(isAgentCommand("claude")).toBe(true);
        expect(isAgentCommand("cursor")).toBe(true);
        expect(isAgentCommand("codex")).toBe(true);
        expect(isAgentCommand("aider")).toBe(true);
        expect(isAgentCommand(" claude ")).toBe(true);
        expect(isAgentCommand("vim")).toBe(false);
        expect(isAgentCommand("bash")).toBe(false);
        expect(isAgentCommand("")).toBe(false);
        expect(isAgentCommand(undefined)).toBe(false);
    });
});

describe("buildAttentionItems — QA filtering", () => {
    test("includes action-unread-today QA with qa deep link + namespaced id", () => {
        const items = buildAttentionItems({
            qaEntries: [qaRow({ id: "abc", ts: TODAY_AM, tag: "action", question: "Approve?" })],
            ttydSessions: [],
            now: NOW,
        });

        expect(items).toHaveLength(1);
        expect(items[0].id).toBe("qa:abc");
        expect(items[0].kind).toBe("agent-question");
        expect(items[0].title).toBe("Approve?");
        expect(items[0].subtitle).toBe("GenesisTools");
        expect(items[0].deepLink).toEqual({ kind: "qa", qaId: "abc" });
    });

    test("excludes read action QA", () => {
        const items = buildAttentionItems({
            qaEntries: [qaRow({ id: "abc", ts: TODAY_AM, tag: "action", readAt: TODAY_AM + 1 })],
            ttydSessions: [],
            now: NOW,
        });

        expect(items).toHaveLength(0);
    });

    test("excludes non-action tags even when unread", () => {
        const items = buildAttentionItems({
            qaEntries: [
                qaRow({ id: "q1", ts: TODAY_AM, tag: "question" }),
                qaRow({ id: "d1", ts: TODAY_AM, tag: "directive" }),
            ],
            ttydSessions: [],
            now: NOW,
        });

        expect(items).toHaveLength(0);
    });

    test("excludes yesterday's action items (today window)", () => {
        const items = buildAttentionItems({
            qaEntries: [qaRow({ id: "old", ts: YESTERDAY, tag: "action" })],
            ttydSessions: [],
            now: NOW,
        });

        expect(items).toHaveLength(0);
    });

    test("subtitle falls back to agentLabel then dash", () => {
        const noProject = buildAttentionItems({
            qaEntries: [qaRow({ id: "a", ts: TODAY_AM, tag: "action", project: "", agentLabel: "claude-code" })],
            ttydSessions: [],
            now: NOW,
        });
        expect(noProject[0].subtitle).toBe("claude-code");

        const nothing = buildAttentionItems({
            qaEntries: [qaRow({ id: "b", ts: TODAY_AM, tag: "action", project: "", agentLabel: null })],
            ttydSessions: [],
            now: NOW,
        });
        expect(nothing[0].subtitle).toBe("—");
    });
});

describe("buildAttentionItems — ttyd filtering", () => {
    test("includes agent sessions with terminal deep link + namespaced id", () => {
        const items = buildAttentionItems({
            qaEntries: [],
            ttydSessions: [ttyd({ id: "ttyd-1", lastCommand: "claude", cwd: "/Users/me/proj" })],
            now: NOW,
        });

        expect(items).toHaveLength(1);
        expect(items[0].id).toBe("ttyd:ttyd-1");
        expect(items[0].kind).toBe("agent-session");
        expect(items[0].title).toBe("claude");
        expect(items[0].subtitle).toBe("claude · proj");
        expect(items[0].deepLink).toEqual({ kind: "terminal", ttydTabId: "ttyd-1" });
    });

    test("manual name wins over lastCommand for title", () => {
        const items = buildAttentionItems({
            qaEntries: [],
            ttydSessions: [ttyd({ id: "t2", lastCommand: "claude", name: "Dev shell" })],
            now: NOW,
        });

        expect(items[0].title).toBe("Dev shell");
    });

    test("excludes non-agent / missing lastCommand sessions", () => {
        const items = buildAttentionItems({
            qaEntries: [],
            ttydSessions: [
                ttyd({ id: "a", lastCommand: "vim" }),
                ttyd({ id: "b", lastCommand: "zsh" }),
                ttyd({ id: "c" }),
            ],
            now: NOW,
        });

        expect(items).toHaveLength(0);
    });

    test("NaN startedAt falls back to now for ts", () => {
        const items = buildAttentionItems({
            qaEntries: [],
            ttydSessions: [ttyd({ id: "t", lastCommand: "claude", startedAt: "not-a-date" })],
            now: NOW,
        });

        expect(items[0].ts).toBe(NOW);
    });
});

describe("buildAttentionItems — ordering & count", () => {
    test("newest first; tie breaks QA before terminal", () => {
        const items = buildAttentionItems({
            qaEntries: [
                qaRow({ id: "newer", ts: TODAY_AM, tag: "action" }),
                qaRow({ id: "tie", ts: TODAY_EARLIER, tag: "action" }),
            ],
            ttydSessions: [ttyd({ id: "tieT", lastCommand: "claude", startedAt: new Date(TODAY_EARLIER).toISOString() })],
            now: NOW,
        });

        // newer QA first, then the tie at TODAY_EARLIER: QA before terminal.
        expect(items.map((i) => i.id)).toEqual(["qa:newer", "qa:tie", "ttyd:tieT"]);
    });

    test("count parity — result length matches included fixtures", () => {
        const items = buildAttentionItems({
            qaEntries: [
                qaRow({ id: "ok", ts: TODAY_AM, tag: "action" }),
                qaRow({ id: "read", ts: TODAY_AM, tag: "action", readAt: NOW }),
                qaRow({ id: "old", ts: YESTERDAY, tag: "action" }),
            ],
            ttydSessions: [ttyd({ id: "agent", lastCommand: "codex" }), ttyd({ id: "shell", lastCommand: "zsh" })],
            now: NOW,
        });

        expect(items).toHaveLength(2);
    });
});
