import { describe, expect, test } from "bun:test";
import type { FleetEntry } from "@genesiscz/utils/ai/live-sessions/fleet";
import type { PsRow } from "@genesiscz/utils/process/ps";
import type { AgentNode, AgentParent, AgentsTree } from "../agents/index";
import type { ProcsSources } from "../procs/sources";
import type { SignalOps } from "../procs/stop";
import { agentsBoard, type BoardDeps, diffPhases, phaseRowOf } from "./index";
import { type BoardStopDeps, stopAgentSession } from "./stop";

// Invented session ids, pids, paths and accounts.
const NOW = Date.parse("2026-10-01T12:00:00Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const HOME = "/Users/alice";

function entry(extra: Partial<FleetEntry> & Pick<FleetEntry, "provider">): FleetEntry {
    return {
        sessionId: null,
        match: "journal",
        surface: null,
        process: null,
        cwd: null,
        transcriptPath: null,
        phase: "idle",
        stalled: false,
        label: "idle",
        activity: null,
        stuck: null,
        transcript: null,
        lastText: null,
        lastActivityAt: NOW - 60_000,
        ...extra,
    };
}

function proc(pid: number, provider: FleetEntry["provider"]): NonNullable<FleetEntry["process"]> {
    return { pid, ppid: 110, tty: "ttys001", provider, argvSessionId: null, startMs: null, command: provider };
}

function node(id: string, extra: Partial<AgentNode> = {}): AgentNode {
    return {
        id,
        harness: "claude",
        kind: "background",
        name: null,
        description: "review the diff",
        agentType: "general-purpose",
        model: "sonnet",
        account: null,
        status: "running",
        startedAt: null,
        lastAt: "2026-10-01T11:59:00Z",
        toolCalls: 3,
        unreadMail: 0,
        team: null,
        backendType: null,
        filePath: null,
        spawnPrompt: null,
        spawnPromptPreview: null,
        toolUseId: null,
        spawnDepth: 1,
        children: [],
        ...extra,
    };
}

function parent(sessionId: string, children: AgentNode[]): AgentParent {
    return {
        sessionId,
        provider: "claude",
        title: "board work",
        project: "shop",
        cwd: "/work/shop",
        filePath: `/work/${sessionId}.jsonl`,
        model: "opus",
        account: "work",
        startedAt: null,
        lastAt: "2026-10-01T11:59:00Z",
        live: true,
        children,
    };
}

function boardDeps(fleet: FleetEntry[], tree: AgentsTree, asked: Set<string>[] = []): BoardDeps {
    return {
        fleet: async () => fleet,
        tree: async (ids) => {
            asked.push(ids);
            return tree;
        },
        lastPrompt: async (row) => (row.sessionId === S1 ? "fix the   failing\ntest" : null),
        now: () => NOW,
    };
}

describe("agents board", () => {
    test("joins each live session with its tree parent, folds sub-agents, and ranks stalled and waiting first", async () => {
        const fleet = [
            entry({ provider: "claude", sessionId: S1, process: proc(4100, "claude"), cwd: "/work/shop" }),
            entry({
                provider: "codex",
                sessionId: S2,
                process: proc(4200, "codex"),
                cwd: "/work/garden",
                phase: "waiting",
                label: "waiting",
            }),
            entry({
                provider: "grok",
                process: proc(4300, "grok"),
                phase: "tool",
                label: "stalled",
                stalled: true,
                stuck: { kind: "long-call", detail: "a call runs for 20 min" },
            }),
        ];
        const asked: Set<string>[] = [];
        const tree: AgentsTree = {
            generatedAt: "",
            parents: [parent(S1, [node("a1", { children: [node("a2", { description: null, name: "helper" })] })])],
            orphans: [],
        };
        const board = await agentsBoard(boardDeps(fleet, tree, asked));

        expect(asked).toEqual([new Set([S1, S2])]);
        expect(board.sessions.map((s) => s.key)).toEqual(["grok:pid:4300", `codex:${S2}`, `claude:${S1}`]);

        const claude = board.sessions[2];
        expect(claude).toMatchObject({
            project: "shop",
            account: "work",
            model: "opus",
            title: "board work",
            lastPrompt: "fix the   failing\ntest",
            pid: 4100,
        });
        expect(claude.children).toEqual([
            expect.objectContaining({
                id: "a1",
                name: "review the diff",
                children: [expect.objectContaining({ id: "a2", name: "helper" })],
            }),
        ]);

        // No tree parent: the project comes from the working directory, the rest stays empty.
        expect(board.sessions[1]).toMatchObject({ project: "garden", account: null, model: null, children: [] });
        expect(board.sessions[0]).toMatchObject({ stalled: true, stuck: { kind: "long-call" }, sessionId: null });
    });

    test("a live worker session is folded under the parent that started it, with its phase", async () => {
        const fleet = [
            entry({ provider: "claude", sessionId: S1, process: proc(4100, "claude") }),
            entry({ provider: "codex", sessionId: S2, process: proc(4200, "codex"), phase: "tool", label: "tool" }),
        ];
        const worker = node("w1", { harness: "codex", kind: "worker", nativeSessionId: S2 });
        const tree: AgentsTree = { generatedAt: "", parents: [parent(S1, [worker])], orphans: [] };
        const board = await agentsBoard(boardDeps(fleet, tree));

        expect(board.sessions.map((s) => s.key)).toEqual([`claude:${S1}`]);
        expect(board.sessions[0].children).toEqual([expect.objectContaining({ id: "w1", liveLabel: "tool" })]);
    });

    test("no live session reads no agent tree", async () => {
        const asked: Set<string>[] = [];
        const board = await agentsBoard(boardDeps([], { generatedAt: "", parents: [], orphans: [] }, asked));

        expect(board.sessions).toEqual([]);
        expect(asked).toEqual([]);
    });

    test("diffPhases names the changed rows, and a start or an end as a membership change", () => {
        const a = phaseRowOf(entry({ provider: "claude", sessionId: S1, process: proc(4100, "claude") }));
        const b = phaseRowOf(entry({ provider: "codex", sessionId: S2 }));
        const waiting = { ...a, phase: "waiting" as const, label: "waiting" as const };

        expect(diffPhases([a, b], [a, b])).toEqual({ membershipChanged: false, changed: [] });
        expect(diffPhases([a, b], [waiting, b])).toEqual({ membershipChanged: false, changed: [waiting] });
        expect(diffPhases([a, b], [a]).membershipChanged).toBe(true);
        expect(diffPhases([a], [a, b]).membershipChanged).toBe(true);
    });
});

// A fake process tree: cmux, a shell, and a Claude session with one MCP server. No real process is signalled.
function psRow(pid: number, ppid: number, command: string): PsRow {
    return {
        pid,
        ppid,
        user: "alice",
        stat: "S",
        cpu: 0,
        rss: 10_000,
        startTime: new Date(NOW - 3_600_000),
        command,
    };
}

const ROWS: PsRow[] = [
    psRow(1, 0, "/sbin/launchd"),
    psRow(100, 1, "/Applications/cmux.app/Contents/MacOS/cmux"),
    psRow(110, 100, "/bin/zsh -l"),
    psRow(4100, 110, `${HOME}/.bun/bin/claude --resume ${S1}`),
    psRow(4101, 4100, `node ${HOME}/.bun/bin/context7-mcp`),
];

function fakeStopDeps(fleet: FleetEntry[]): BoardStopDeps & { sent: string[] } {
    const alive = new Set(ROWS.map((row) => row.pid));
    const sent: string[] = [];
    let clock = NOW;
    const sources: ProcsSources = {
        table: async () => ROWS,
        cwdOf: () => null,
        sessions: async () => [],
        launchd: async () => new Map(),
        energy: async () => new Map(),
        own: () => new Set([9999]),
        realpath: (path) => path,
        now: () => NOW,
    };
    const ops: SignalOps = {
        signal: (pid, signal) => {
            sent.push(`${signal} ${pid}`);
            alive.delete(pid);
        },
        alive: (pid) => alive.has(pid),
        identity: (pids) =>
            new Map(
                ROWS.filter((row) => pids.includes(row.pid) && alive.has(row.pid)).map((row) => [
                    row.pid,
                    { startedAt: row.startTime?.toISOString() ?? null, command: row.command },
                ])
            ),
        sleep: async (ms) => {
            clock += ms;
        },
        now: () => clock,
    };
    return { fleet: async () => fleet, sources, ops, graceMs: 1_000, sent };
}

describe("stopAgentSession", () => {
    const live = [entry({ provider: "claude", sessionId: S1, process: proc(4100, "claude") })];

    test("stops the session's process tree, root first", async () => {
        const deps = fakeStopDeps(live);
        const receipt = await stopAgentSession({ key: `claude:${S1}`, pid: 4100 }, deps);

        expect(receipt).toMatchObject({ stopped: true, signal: "TERM", survivors: [], reason: null });
        expect(deps.sent).toEqual(["SIGTERM 4100", "SIGTERM 4101"]);
    });

    test("refuses a session whose agent process is now another pid, and signals nothing", async () => {
        const deps = fakeStopDeps(live);
        const receipt = await stopAgentSession({ key: `claude:${S1}`, pid: 4555 }, deps);

        expect(receipt).toMatchObject({ stopped: false, signal: null });
        expect(receipt.reason).toContain("now 4100");
        expect(deps.sent).toEqual([]);
    });

    test("refuses a session that is no longer live", async () => {
        const deps = fakeStopDeps([]);
        const receipt = await stopAgentSession({ key: `claude:${S1}`, pid: 4100 }, deps);

        expect(receipt.reason).toBe("the session is no longer live");
        expect(deps.sent).toEqual([]);
    });
});
