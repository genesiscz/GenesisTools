import { expect, test } from "bun:test";
import {
    type AdoptedSession,
    closeSession,
    type ListedWorkspace,
    recordedSessionFor,
    type SessionCloseIO,
    surfaceTarget,
} from "./session-close";
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
        workspaceId: "W9",
        surfaceId: "S8",
        tmuxSession: null,
        pidFile: "/state/sessions/codex-app-ab12cd.pid",
        command: "tools codex run side",
        createdAt: "2026-10-08T17:00:00.000Z",
        createdBy: "agents-new",
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
    adoptable?: AdoptedSession | null;
    /** What cmux lists now; called once per listing, so a test can renumber refs mid-close. */
    listing?: (call: number) => ListedWorkspace[];
    /** The UUID behind a surface ref, per lookup; defaults to `uuids`, then `S<n>` for `surface:<n>`. */
    surfaceUuid?: (surface: string, call: number) => string | null;
    /** Fixed UUIDs of listed surfaces, by ref. */
    uuids?: Record<string, string>;
    /** The exit command and the workspace close THROW: a refusal test fails loudly if it reaches them. */
    forbidIrreversible?: boolean;
}): Fake {
    const calls: string[] = [];
    const lines = [...(input.lines ?? [created()])];
    let workspaces = input.workspaces ?? [{ ref: "workspace:9", id: "W9", cwd: "/repo/app" }];
    let surfaces = new Set(["surface:8", "surface:21"]);
    let listings = 0;
    let lookups = 0;
    const uuidOf = (ref: string) => input.uuids?.[ref] ?? `S${ref.split(":")[1]}`;
    const forbid = (step: string) => {
        if (input.forbidIrreversible) {
            throw new Error(`${step} must not run`);
        }
    };
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
        listWorkspaces: async () => {
            listings += 1;
            return input.listing ? input.listing(listings) : workspaces;
        },
        adopt: async (query) => {
            calls.push(`adopt ${query}`);
            return input.adoptable ?? null;
        },
        surfaceId: async (surface) => {
            lookups += 1;

            if (input.surfaceUuid) {
                return input.surfaceUuid(surface, lookups);
            }

            return surfaces.has(surface) ? uuidOf(surface) : null;
        },
        closeSurface: async (surface) => {
            calls.push(`close-surface ${surface}`);
            forbid("the surface close");
            surfaces = new Set([...surfaces].filter((entry) => entry !== surface && uuidOf(entry) !== surface));
        },
        callerWorkspaceId: () => input.caller,
        turnState: async () => (input.turn === undefined ? { sessionId: "s-1", state: "AWAITING-INPUT" } : input.turn),
        sendExit: async (_record, text) => {
            calls.push(`exit ${text}`);
            forbid("the exit command");
        },
        agentRunning: async () => {
            running -= 1;
            return running >= 0;
        },
        closeWorkspace: async (workspace, _window, force) => {
            calls.push(force ? `close ${workspace} --force` : `close ${workspace}`);
            forbid("the workspace close");
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
    expect((await closeSession("workspace:4", { graceMs: 0 }, fake({}).io)).reason).toBe("not-recorded");

    const own = fake({ caller: "W9" });
    const ownReport = await closeSession("codex-app-ab12cd", { graceMs: 0, force: true }, own.io);
    expect(ownReport.reason).toBe("own-workspace");
    expect(own.calls).toEqual([]);

    const moved = fake({
        workspaces: [{ ref: "workspace:9", id: "W-OTHER", cwd: "/repo/app" }],
        forbidIrreversible: true,
    });
    expect((await closeSession("codex-app-ab12cd", { graceMs: 0 }, moved.io)).reason).toBe("workspace-moved");
    expect(moved.calls).toEqual([]);

    const busy = fake({ turn: { sessionId: "s-1", state: "RUNNING" } });
    const busyReport = await closeSession("codex-app-ab12cd", { graceMs: 0 }, busy.io);
    expect(busyReport.reason).toBe("turn-running");
    expect(busyReport.notes[0]).toContain("tools codex wait s-1");
    expect(busy.calls).toEqual([]);

    const stalled = fake({ turn: { sessionId: "s-1", state: "STALLED" } });
    const stalledReport = await closeSession("codex-app-ab12cd", { graceMs: 0 }, stalled.io);
    expect(stalledReport.reason).toBe("turn-running");
    expect(stalledReport.notes[0]).toContain("stalled");
    expect(stalled.calls).toEqual([]);
});

test("an agent that does not quit leaves the workspace open and the record open, unless --force", async () => {
    const stuck = fake({ runningChecks: 1_000 });
    const report = await closeSession("codex-app-ab12cd", { graceMs: 2_000 }, stuck.io);

    expect(report).toMatchObject({ outcome: "partial", reason: "agent-still-running" });
    expect(stuck.calls).toEqual(["exit /quit"]);
    expect(openSessions(stuck.lines)).toHaveLength(1);

    const forced = fake({ runningChecks: 1_000 });
    expect((await closeSession("codex-app-ab12cd", { graceMs: 2_000, force: true }, forced.io)).outcome).toBe("closed");
    // cmux refuses to close a workspace with a live process unless it gets --force too.
    expect(forced.calls).toContain("close workspace:9 --force");
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
test("an agent session agents new did not open is adopted: the agent quits, only its surface closes, nothing is recorded", async () => {
    const adoptable: AdoptedSession = {
        ...created({
            name: "0199aa11-2222-7333-8444-555566667777",
            agent: "grok",
            workspace: "workspace:3",
            surface: "surface:21",
            workspaceId: "W3",
            pidFile: "",
        }),
        createdBy: "adopted",
        surfaceId: "S21",
        sessionId: "0199aa11-2222-7333-8444-555566667777",
        tty: "ttys009",
    };
    const { io, calls, lines } = fake({ adoptable, runningChecks: 2, caller: "W3" });
    const report = await closeSession("0199aa11", { graceMs: 5_000 }, io);

    expect(report).toMatchObject({
        adopted: true,
        agent: "grok",
        outcome: "closed",
        sessionId: "s-1",
        steps: { exitSent: true, agentExited: true, workspaceClosed: true },
    });
    // The close names the surface UUID adoption verified, so a renumbered ref can never be what closes.
    expect(calls).toEqual(["adopt 0199aa11", "exit /exit", "close-surface S21"]);
    expect(lines.filter((line) => line.type === "closed")).toEqual([]);
});

function adoptedGrok(): AdoptedSession {
    return {
        ...created({
            name: "0199ee55-0000-7000-8000-000000000005",
            agent: "grok",
            workspace: "workspace:3",
            surface: "surface:21",
            workspaceId: "W3",
            pidFile: "",
        }),
        createdBy: "adopted",
        sessionId: "0199ee55-0000-7000-8000-000000000005",
        surfaceId: "S21",
        tty: "ttys012",
    };
}

test("an adopted surface ref that names another surface after adoption gets no exit and no close, even with --force", async () => {
    // cmux restarts during the turn check: lookup 1 (the first check) still sees S21, lookup 2 (before the exit) does not.
    for (const force of [false, true]) {
        const restarted = fake({
            adoptable: adoptedGrok(),
            surfaceUuid: (_surface, call) => (call === 1 ? "S21" : "S-OTHER"),
            forbidIrreversible: true,
        });
        const report = await closeSession("0199ee55", { graceMs: 1_000, force }, restarted.io);

        expect(report).toMatchObject({ adopted: true, outcome: "refused", reason: "workspace-moved" });
        expect(report.steps.exitSent).toBe(false);
        expect(restarted.calls).toEqual(["adopt 0199ee55"]);
    }

    // A restart during the exit grace: the agent quit, but the ref now names another terminal, which stays open.
    const duringGrace = fake({
        adoptable: adoptedGrok(),
        surfaceUuid: (_surface, call) => (call <= 2 ? "S21" : "S-OTHER"),
        runningChecks: 1,
    });
    const graceReport = await closeSession("0199ee55", { graceMs: 1_000 }, duringGrace.io);

    expect(graceReport).toMatchObject({ outcome: "refused", reason: "workspace-moved" });
    expect(duringGrace.calls).toEqual(["adopt 0199ee55", "exit /exit"]);

    // The surface is gone by the time of the check: nothing to do, nothing typed anywhere.
    const gone = fake({ adoptable: adoptedGrok(), surfaceUuid: () => null, forbidIrreversible: true });
    expect((await closeSession("0199ee55", { graceMs: 0 }, gone.io)).reason).toBe("not-found");
});

test("an adopted session whose surface UUID holds through every check closes by that UUID", async () => {
    const steady = fake({ adoptable: adoptedGrok(), runningChecks: 1 });
    const report = await closeSession("0199ee55", { graceMs: 1_000 }, steady.io);

    expect(report).toMatchObject({ outcome: "closed", reason: null, steps: { exitSent: true, workspaceClosed: true } });
    expect(steady.calls).toEqual(["adopt 0199ee55", "exit /exit", "close-surface S21"]);
});

test("the exit command and the close target an adopted session's UUID and a recorded session's ref", () => {
    expect(surfaceTarget(adoptedGrok())).toBe("S21");
    expect(surfaceTarget(created())).toBe("surface:8");
});

test("a live session belongs to the open record holding its surface UUID, never to one holding only its old ref", () => {
    const open = [
        created({ surface: "surface:8", surfaceId: "S8" }),
        created({ name: "legacy", surfaceId: undefined }),
    ];

    expect(recordedSessionFor(open, "s8")?.name).toBe("codex-app-ab12cd");
    // After a restart a new surface took `surface:8`: the stale record does not claim (and hide) it.
    expect(recordedSessionFor(open, "S-NEW")).toBeUndefined();
});

test("adoption runs only when no record matches, and a refused adopt leaves the bare-workspace rule in place", async () => {
    const recorded = fake({ runningChecks: 0 });
    await closeSession("codex-app", { graceMs: 0 }, recorded.io);
    expect(recorded.calls.some((call) => call.startsWith("adopt"))).toBe(false);

    const nothing = fake({ adoptable: null });
    const report = await closeSession("workspace:4", { graceMs: 0 }, nothing.io);
    expect(report.reason).toBe("not-recorded");
    expect(nothing.calls).toEqual(["adopt workspace:4"]);
});

test("a session id whose surface agents new recorded closes as the recorded session", async () => {
    const adoptable: AdoptedSession = {
        ...created({ name: "0199bb22-0000-7000-8000-000000000001", surface: "surface:8", pidFile: "" }),
        createdBy: "adopted",
        surfaceId: "S8",
        sessionId: "0199bb22-0000-7000-8000-000000000001",
        tty: "ttys010",
    };
    const { io, calls } = fake({ adoptable, runningChecks: 1 });
    const report = await closeSession("0199bb22", { graceMs: 5_000 }, io);

    expect(report).toMatchObject({ adopted: false, session: "codex-app-ab12cd", outcome: "closed" });
    expect(calls).toContain("close workspace:9");
});

test("a recorded session whose UUIDs match closes even after its shell changed folder", async () => {
    const drifted = fake({ workspaces: [{ ref: "workspace:9", id: "w9", cwd: "/repo/app/sub" }], runningChecks: 1 });
    const report = await closeSession("codex-app-ab12cd", { graceMs: 1_000 }, drifted.io);

    expect(report).toMatchObject({ outcome: "closed", reason: null });
    expect(drifted.calls).toEqual(["exit /quit", "close workspace:9"]);
});

test("a record without cmux UUIDs is never acted on without --force, and --force still closes it", async () => {
    const legacy = [created({ workspaceId: undefined, surfaceId: undefined })];
    const refused = fake({ lines: legacy, forbidIrreversible: true });
    const report = await closeSession("codex-app-ab12cd", { graceMs: 0 }, refused.io);

    expect(report.reason).toBe("identity-unknown");
    expect(report.notes[0]).toContain("pass --force");
    expect(refused.calls).toEqual([]);

    const forced = fake({ lines: legacy, runningChecks: 1 });
    expect((await closeSession("codex-app-ab12cd", { graceMs: 1_000, force: true }, forced.io)).outcome).toBe("closed");
    expect(forced.calls).toEqual(["exit /quit", "close workspace:9 --force"]);
});

test("a renumbered surface ref is refused before the exit command is typed into it", async () => {
    const other = fake({ surfaceUuid: () => "S-OTHER", forbidIrreversible: true });
    expect((await closeSession("codex-app-ab12cd", { graceMs: 0 }, other.io)).reason).toBe("workspace-moved");
    expect(other.calls).toEqual([]);

    // cmux restarts between the first check and the exit: the second lookup already names another surface.
    const restarted = fake({
        surfaceUuid: (_surface, call) => (call === 1 ? "S8" : "S-OTHER"),
        forbidIrreversible: true,
    });
    const report = await closeSession("codex-app-ab12cd", { graceMs: 0 }, restarted.io);
    expect(report.reason).toBe("workspace-moved");
    expect(report.steps.exitSent).toBe(false);
    expect(restarted.calls).toEqual([]);
});

test("a workspace ref that turns into another workspace after the exit is refused before it closes", async () => {
    const own = { ref: "workspace:9", id: "W9", cwd: "/repo/app" };
    const swapped = fake({
        // Listings 1 to 3: the first look, the identity check, the check before the exit. The fourth is before the close.
        listing: (call) => (call <= 3 ? [own] : [{ ...own, id: "W-OTHER" }]),
        runningChecks: 1,
    });
    const report = await closeSession("codex-app-ab12cd", { graceMs: 1_000 }, swapped.io);

    expect(report).toMatchObject({ outcome: "refused", reason: "workspace-moved" });
    expect(report.steps.exitSent).toBe(true);
    expect(swapped.calls).toEqual(["exit /quit"]);
});

test("an adopted session on a stale record's surface ref but another surface UUID closes as adopted, not as the record", async () => {
    const adoptable: AdoptedSession = {
        ...created({
            name: "0199dd44-0000-7000-8000-000000000004",
            surface: "surface:8",
            pidFile: "",
        }),
        createdBy: "adopted",
        surfaceId: "S-NEW",
        sessionId: "0199dd44-0000-7000-8000-000000000004",
        tty: "ttys011",
    };
    // cmux lists the new surface (UUID S-NEW) at the stale record's ref.
    const { io, calls } = fake({ adoptable, runningChecks: 1, uuids: { "surface:8": "S-NEW" } });
    const report = await closeSession("0199dd44", { graceMs: 5_000 }, io);

    expect(report).toMatchObject({ adopted: true, outcome: "closed" });
    expect(calls).toContain("close-surface S-NEW");
    expect(calls).not.toContain("close workspace:9");
});
