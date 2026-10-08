import { sessionAgent } from "./session-agents";
import { openSessions, type SessionCreatedRecord, type SessionStore } from "./session-store";

export type CloseReason =
    | "not-found"
    | "ambiguous"
    | "not-created-by-session-new"
    | "workspace-moved"
    | "own-workspace"
    | "turn-running"
    | "agent-still-running";

export interface CloseSteps {
    exitSent: boolean;
    agentExited: boolean;
    workspaceClosed: boolean;
    tmuxKilled: boolean;
}

export interface CloseReport {
    session: string;
    agent: string | null;
    sessionId: string | null;
    turnState: string | null;
    workspace: string;
    window: string | null;
    tmuxSession: string | null;
    dryRun: boolean;
    steps: CloseSteps;
    outcome: "closed" | "refused" | "partial" | "planned";
    reason: CloseReason | null;
    /** Text for a human: why it refused, or what stays behind (a tmux session). */
    notes: string[];
}

export interface ListedWorkspace {
    ref: string;
    id: string;
    cwd: string | null;
}

export interface SessionCloseIO {
    store: SessionStore;
    listWorkspaces(window: string | null): Promise<ListedWorkspace[]>;
    /** The workspace this command runs in (`CMUX_WORKSPACE_ID`), never closed. */
    callerWorkspaceId(): string | undefined;
    /** The agent session in the record's surface and its turn state, or null when no hook recorded one. */
    turnState(record: SessionCreatedRecord): Promise<{ sessionId: string; state: string } | null>;
    sendExit(record: SessionCreatedRecord, text: string): Promise<void>;
    /** True while the shell that ran the agent still has a child (the agent). */
    agentRunning(record: SessionCreatedRecord): Promise<boolean>;
    closeWorkspace(workspace: string, window: string | null): Promise<void>;
    killTmux(session: string): Promise<void>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

export interface CloseOptions {
    force?: boolean;
    killTmux?: boolean;
    dryRun?: boolean;
    graceMs: number;
}

const EXIT_POLL_MS = 500;
/** cmux lists a closed workspace for a moment after `workspace close` returns (measured 2026-10-08). */
const CLOSE_SETTLE_MS = 3_000;

type Target =
    | { kind: "record"; record: SessionCreatedRecord }
    | { kind: "bare"; workspace: string }
    | { kind: "none"; reason: "not-found" | "ambiguous"; note: string };

/** A record name, a unique name prefix, or the record's workspace ref. A bare `workspace:N` is a candidate for --force. */
export function resolveCloseTarget(query: string, records: readonly SessionCreatedRecord[]): Target {
    const trimmed = query.trim();
    const exact = records.filter((record) => record.name === trimmed || record.workspace === trimmed);

    if (exact.length === 1) {
        return { kind: "record", record: exact[0] };
    }

    const prefixed = exact.length > 1 ? exact : records.filter((record) => record.name.startsWith(trimmed));

    if (prefixed.length === 1) {
        return { kind: "record", record: prefixed[0] };
    }

    if (prefixed.length > 1) {
        return {
            kind: "none",
            reason: "ambiguous",
            note: `"${trimmed}" matches ${prefixed.length} sessions: ${prefixed.map((record) => record.name).join(", ")}`,
        };
    }

    if (/^workspace:\d+$/.test(trimmed)) {
        return { kind: "bare", workspace: trimmed };
    }

    return { kind: "none", reason: "not-found", note: `no open session named "${trimmed}" (see: session agent list)` };
}

function emptySteps(): CloseSteps {
    return { exitSent: false, agentExited: false, workspaceClosed: false, tmuxKilled: false };
}

/**
 * Close a session `session agent new` opened: quit the agent, then close its workspace.
 *
 * Order and refusals follow `GenesisBot/Common/Dev/proposals/cmux-session-close.md`. It never closes the
 * caller's own workspace, never a workspace without a record unless `force`, never an agent in the middle of
 * a turn unless `force`, and never kills tmux unless `killTmux`. The transcript always stays.
 */
export async function closeSession(query: string, options: CloseOptions, io: SessionCloseIO): Promise<CloseReport> {
    const target = resolveCloseTarget(query, openSessions(io.store.read()));
    const record = target.kind === "record" ? target.record : null;
    const report: CloseReport = {
        session: record?.name ?? query.trim(),
        agent: record?.agent ?? null,
        sessionId: null,
        turnState: null,
        workspace: record?.workspace ?? (target.kind === "bare" ? target.workspace : ""),
        window: record?.window ?? null,
        tmuxSession: record?.tmuxSession ?? null,
        dryRun: options.dryRun === true,
        steps: emptySteps(),
        outcome: "refused",
        reason: null,
        notes: [],
    };
    const refuse = (reason: CloseReason, note: string): CloseReport => {
        report.outcome = "refused";
        report.reason = reason;
        report.notes.push(note);
        return report;
    };

    if (target.kind === "none") {
        return refuse(target.reason, target.note);
    }

    if (target.kind === "bare" && !options.force) {
        return refuse(
            "not-created-by-session-new",
            `${target.workspace} has no session record; pass --force to close the workspace anyway`
        );
    }

    const listed = (await io.listWorkspaces(report.window)).find((workspace) => workspace.ref === report.workspace);
    const caller = io.callerWorkspaceId();

    if (listed && caller && listed.id === caller) {
        return refuse("own-workspace", `${report.workspace} is the workspace this command runs in; it is never closed`);
    }

    if (record && listed && listed.cwd && listed.cwd !== record.cwd && !options.force) {
        return refuse(
            "workspace-moved",
            `${record.workspace} now holds ${listed.cwd}, not ${record.cwd}; cmux refs renumber after a restart. Pass --force if it is the right one`
        );
    }

    if (record) {
        const turn = await io.turnState(record);
        report.sessionId = turn?.sessionId ?? null;
        report.turnState = turn?.state ?? null;

        if (!turn) {
            report.notes.push("no agent session is recorded for this surface; the turn state is unknown");
        }

        if (turn?.state === "RUNNING" && !options.force) {
            return refuse(
                "turn-running",
                `the ${record.agent} turn is still running; wait first: tools ${record.agent} wait ${turn.sessionId}, or pass --force`
            );
        }
    }

    if (options.dryRun) {
        report.outcome = "planned";
        report.notes.push(
            listed ? `would quit the agent and close ${report.workspace}` : `${report.workspace} is already gone`
        );
        return report;
    }

    if (record && listed && (await io.agentRunning(record))) {
        await io.sendExit(record, sessionAgent(record.agent).exitCommand);
        report.steps.exitSent = true;

        const deadline = io.now() + options.graceMs;

        while (io.now() < deadline && (await io.agentRunning(record))) {
            await io.sleep(Math.min(EXIT_POLL_MS, Math.max(0, deadline - io.now())));
        }

        report.steps.agentExited = !(await io.agentRunning(record));

        if (!report.steps.agentExited && !options.force) {
            report.outcome = "partial";
            report.reason = "agent-still-running";
            report.notes.push(
                `the agent did not quit within ${Math.round(options.graceMs / 1000)} s; the workspace stays open. Pass --force to close it anyway`
            );
            return report;
        }
    } else if (record) {
        report.steps.agentExited = true;
    }

    if (listed) {
        await io.closeWorkspace(report.workspace, report.window);
    }

    const listedNow = async () =>
        (await io.listWorkspaces(report.window)).some((workspace) => workspace.ref === report.workspace);
    const settleBy = io.now() + CLOSE_SETTLE_MS;
    let stillThere = await listedNow();

    while (stillThere && io.now() < settleBy) {
        await io.sleep(EXIT_POLL_MS);
        stillThere = await listedNow();
    }

    report.steps.workspaceClosed = !stillThere;

    if (record?.tmuxSession) {
        if (options.killTmux) {
            await io.killTmux(record.tmuxSession);
            report.steps.tmuxKilled = true;
        } else {
            report.notes.push(
                `tmux session ${record.tmuxSession} stays: tmux attach -t ${record.tmuxSession}, or close again with --kill-tmux`
            );
        }
    }

    report.outcome = report.steps.workspaceClosed ? "closed" : "partial";

    // A partial close keeps the record open, so a second `close` can finish the job.
    if (record && report.outcome === "closed") {
        io.store.append({
            type: "closed",
            name: record.name,
            closedAt: new Date(io.now()).toISOString(),
            outcome: report.outcome,
            steps: { ...report.steps },
        });
    }

    return report;
}
