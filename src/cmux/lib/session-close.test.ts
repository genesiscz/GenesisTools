import { expect, test } from "bun:test";
import { closeSession, type ListedWorkspace, type SessionCloseIO } from "./session-close";
import { openSessions, type SessionCreatedRecord, type SessionRecordLine } from "./session-store";

function created(overrides: Partial<SessionCreatedRecord> = {}): SessionCreatedRecord {
    return {
        type: "created",
        name: "codex-app-ab12cd",
        agent: "codex",
        account: "side",
        model: null,
        cwd: "/repo/app",
        window: "window:1",
        workspace: "workspace:9",
        surface: "surface:8",
        tmuxSession: null,
        pidFile: "/state/sessions/codex-app-ab12cd.pid",
        command: "tools codex run side",
        createdAt: "2026-10-08T17:00:00.000Z",
        createdBy: "session-agent-new",
        ...overrides,
    };
}

interface Fake {
    io: SessionCloseIO;
    calls: string[];
    lines: SessionRecordLine[];
}

function fake(input: {
    lines?: SessionRecordLine[];
    workspaces?: ListedWorkspace[];
    caller?: string;
    turn?: { sessionId: string; state: string } | null;
    /** How many `agentRunning` checks answer true before the agent is gone. */
    runningChecks?: number;
}): Fake {
    const calls: string[] = [];
    const lines = [...(input.lines ?? [created()])];
    let workspaces = input.workspaces ?? [{ ref: "workspace:9", id: "W9", cwd: "/repo/app" }];
    let running = input.runningChecks ?? 2;
    let clock = 0;
    const io: SessionCloseIO = {
        store: {
            read: () => [...lines],
            append: (line) => {
                lines.push(line);
            },
            pidFile: (name) => `/state/sessions/${name}.pid`,
        },
        listWorkspaces: async () => workspaces,
        callerWorkspaceId: () => input.caller,
        turnState: async () => (input.turn === undefined ? { sessionId: "s-1", state: "AWAITING-INPUT" } : input.turn),
        sendExit: async (_record, text) => {
            calls.push(`exit ${text}`);
        },
        agentRunning: async () => {
            running -= 1;
            return running >= 0;
        },
        closeWorkspace: async (workspace) => {
            calls.push(`close ${workspace}`);
            workspaces = workspaces.filter((entry) => entry.ref !== workspace);
        },
        killTmux: async (session) => {
            calls.push(`kill ${session}`);
        },
        sleep: async (ms) => {
            clock += ms;
        },
        now: () => clock,
    };

    return { io, calls, lines };
}

test("a recorded session quits its agent with the agent's own command, then its workspace closes", async () => {
    const { io, calls, lines } = fake({ runningChecks: 3 });
    const report = await closeSession("codex-app", { graceMs: 10_000 }, io);

    expect(report).toMatchObject({
        session: "codex-app-ab12cd",
        outcome: "closed",
        reason: null,
        sessionId: "s-1",
        steps: { exitSent: true, agentExited: true, workspaceClosed: true, tmuxKilled: false },
    });
    expect(calls).toEqual(["exit /quit", "close workspace:9"]);
    expect(openSessions(lines)).toEqual([]);
});

test("no record, the caller's own workspace, a moved ref and a running turn are refused", async () => {
    expect((await closeSession("nobody", { graceMs: 0 }, fake({}).io)).reason).toBe("not-found");
    expect((await closeSession("workspace:4", { graceMs: 0 }, fake({}).io)).reason).toBe("not-created-by-session-new");

    const own = fake({ caller: "W9" });
    const ownReport = await closeSession("codex-app-ab12cd", { graceMs: 0, force: true }, own.io);
    expect(ownReport.reason).toBe("own-workspace");
    expect(own.calls).toEqual([]);

    const moved = fake({ workspaces: [{ ref: "workspace:9", id: "W9", cwd: "/other" }] });
    expect((await closeSession("codex-app-ab12cd", { graceMs: 0 }, moved.io)).reason).toBe("workspace-moved");

    const busy = fake({ turn: { sessionId: "s-1", state: "RUNNING" } });
    const busyReport = await closeSession("codex-app-ab12cd", { graceMs: 0 }, busy.io);
    expect(busyReport.reason).toBe("turn-running");
    expect(busyReport.notes[0]).toContain("tools codex wait s-1");
    expect(busy.calls).toEqual([]);
});

test("an agent that does not quit leaves the workspace open and the record open, unless --force", async () => {
    const stuck = fake({ runningChecks: 1_000 });
    const report = await closeSession("codex-app-ab12cd", { graceMs: 2_000 }, stuck.io);

    expect(report).toMatchObject({ outcome: "partial", reason: "agent-still-running" });
    expect(stuck.calls).toEqual(["exit /quit"]);
    expect(openSessions(stuck.lines)).toHaveLength(1);

    const forced = fake({ runningChecks: 1_000 });
    expect((await closeSession("codex-app-ab12cd", { graceMs: 2_000, force: true }, forced.io)).outcome).toBe("closed");
});

test("a dry run plans and touches nothing, and tmux stays unless --kill-tmux", async () => {
    const dry = fake({});
    expect((await closeSession("codex-app-ab12cd", { graceMs: 0, dryRun: true }, dry.io)).outcome).toBe("planned");
    expect(dry.calls).toEqual([]);

    const tmux = [created({ tmuxSession: "cmux-app-ab12cd" })];
    const kept = await closeSession("codex-app-ab12cd", { graceMs: 1_000 }, fake({ lines: tmux }).io);
    expect(kept.notes.join(" ")).toContain("tmux session cmux-app-ab12cd stays");

    const killed = fake({ lines: tmux });
    await closeSession("codex-app-ab12cd", { graceMs: 1_000, killTmux: true }, killed.io);
    expect(killed.calls).toContain("kill cmux-app-ab12cd");
});
