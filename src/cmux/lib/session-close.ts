import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import type { TmuxListing, TmuxPaneInfo } from "@genesiscz/utils/tmux/sessions";
import { sessionAgent } from "./session-agents";
import { openSessions, type SessionCreatedRecord, SessionNameBusyError, type SessionStore } from "./session-store";

export type CloseReason =
    | "not-found"
    | "ambiguous"
    | "not-recorded"
    | "workspace-moved"
    | "identity-unknown"
    | "own-workspace"
    | "turn-running"
    | "agent-still-running"
    | "in-use";

export interface CloseSteps {
    exitSent: boolean;
    agentExited: boolean;
    workspaceClosed: boolean;
    tmuxKilled: boolean;
}

export interface CloseReport {
    session: string;
    agent: string | null;
    /** True when the session was not opened by `agents new` and was found through the cmux-refs journal. */
    adopted: boolean;
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

/**
 * An agent session `agents new` did not open, found through the cmux-refs journal (every Claude, Codex
 * and Grok session records its surface there). It has no pid file and may share its workspace with
 * other panes, so `close` quits the agent and closes only its surface.
 */
export interface AdoptedSession extends Omit<SessionCreatedRecord, "createdBy" | "surfaceId"> {
    createdBy: "adopted";
    sessionId: string;
    /** The live surface's UUID at adoption. The exit command and the surface close target it, never the ref. */
    surfaceId: string;
    /** The surface's terminal (`ttys012`): the agent counts as running while a process on it is the agent. */
    tty: string | null;
}

export type CloseSubject = SessionCreatedRecord | AdoptedSession;

export function isAdopted(subject: CloseSubject): subject is AdoptedSession {
    return subject.createdBy === "adopted";
}

/**
 * The surface the exit command and a surface close name on the cmux command line. An adopted session names its
 * UUID, which no other surface can take after a cmux restart; a recorded session names its ref, which the
 * identity checks verify right before each step (and `--force` may override).
 */
export function surfaceTarget(subject: CloseSubject): string {
    return isAdopted(subject) ? subject.surfaceId : subject.surface;
}

/** Journal entries older than this before a record's start belong to an earlier occupant of its surface. */
const JOURNAL_START_SLACK_MS = 60_000;

/**
 * The newest agent session the cmux-refs journal places in a recorded session since it started, or null.
 *
 * A --via-tmux agent starts in a detached tmux shell before its workspace exists, with the cmux identity
 * unset (session-new.ts `CMUX_IDENTITY_ENV`), so the hook records its tmux pane, never the new surface: such a
 * record matches by the panes of its tmux session. Any other record matches by surface UUID, or by ref when
 * it was written before UUIDs were stored.
 */
export function recordedSessionIdOf(input: {
    record: SessionCreatedRecord;
    refs: Iterable<SessionCmuxRefs>;
    tmuxPanes: readonly string[];
}): string | null {
    const { record } = input;
    const since = Date.parse(record.createdAt) - JOURNAL_START_SLACK_MS;
    const inSession = (entry: SessionCmuxRefs): boolean => {
        // Another agent in the same surface or tmux session is not this record's agent.
        if (entry.provider !== undefined && entry.provider !== record.agent) {
            return false;
        }

        if (record.tmuxSession) {
            return entry.tmuxPane !== null && input.tmuxPanes.includes(entry.tmuxPane);
        }

        return record.surfaceId ? sameId(entry.surfaceId, record.surfaceId) : entry.surfaceRef === record.surface;
    };
    let newest: SessionCmuxRefs | null = null;

    for (const entry of input.refs) {
        if (entry.at >= since && inSession(entry) && (!newest || entry.at > newest.at)) {
            newest = entry;
        }
    }

    return newest?.sessionId ?? null;
}

/**
 * The tmux target the exit command is typed into: the agent's own pane when it is known, else (a record written
 * before panes were stored) the session's current pane. `=name:` matches the session name exactly.
 */
export function tmuxExitTarget(subject: CloseSubject): string | null {
    if (!subject.tmuxSession) {
        return null;
    }

    return subject.tmuxPane ?? `=${subject.tmuxSession}:`;
}

/** `/dev/ttys012` (tmux) and `ttys012` (cmux) name the same terminal. */
function sameTty(left: string | null | undefined, right: string | null | undefined): boolean {
    const name = (tty: string | null | undefined) => tty?.replace(/^\/dev\//, "") ?? "";
    return name(left) !== "" && name(left) === name(right);
}

/**
 * Why the agent's tmux pane is no longer the one the exit command may be typed into, or null when it is. The pane
 * must still belong to the session; for an adopted session it must also still run on the tty adoption saw. tmux
 * pane ids are reused after a tmux server restart, and the cmux surface UUID cannot tell (the client surface stays).
 */
async function tmuxPaneProblem(
    record: CloseSubject,
    io: Pick<SessionCloseIO, "tmuxPanes">
): Promise<{ reason: CloseReason; note: string } | null> {
    if (!record.tmuxSession || !record.tmuxPane) {
        return null;
    }

    const listing = await io.tmuxPanes(record.tmuxSession);

    if (!listing.ok) {
        return {
            reason: "identity-unknown",
            note: `the tmux pane ${record.tmuxPane} could not be checked (${listing.reason}), so nothing is typed into it`,
        };
    }

    const pane = listing.items.find((entry) => entry.pane === record.tmuxPane);
    const ttyMoved = isAdopted(record) && pane !== undefined && !sameTty(pane.tty, record.tty);
    // A tmux server restart can bring back a session with the same name and pane id: its creation time differs.
    const created = record.tmuxSessionCreatedMs;
    const replaced =
        pane !== undefined && created !== undefined && created !== null && pane.sessionCreatedMs !== created;

    if (replaced) {
        return {
            reason: "workspace-moved",
            note: `tmux session ${record.tmuxSession} is a newer session than the recorded one, so nothing is typed into pane ${record.tmuxPane}`,
        };
    }

    if (!pane || ttyMoved) {
        return {
            reason: "workspace-moved",
            note: `tmux pane ${record.tmuxPane} is ${pane ? "now another terminal" : "no longer in"} ${record.tmuxSession}, so the exit command has no safe target`,
        };
    }

    return null;
}

/**
 * What `--kill-tmux` may kill, checked right before the kill: the session id (`$3`) of the session that still has
 * the recorded name AND the recorded creation time. Another session that took the name after this one ended is
 * never killed. A record from before creation times were stored is killed by its exact name.
 */
async function tmuxKillTarget(
    record: CloseSubject,
    session: string,
    io: Pick<SessionCloseIO, "tmuxPanes">
): Promise<{ kind: "kill"; target: string } | { kind: "skip"; note: string; leftBehind: boolean }> {
    const listing = await io.tmuxPanes(session);

    if (!listing.ok) {
        return {
            kind: "skip",
            leftBehind: true,
            note: `tmux session ${session} was not killed: it could not be checked (${listing.reason})`,
        };
    }

    const live = listing.items[0];

    if (!live) {
        return { kind: "skip", leftBehind: false, note: `tmux session ${session} is already gone` };
    }

    const recorded = record.tmuxSessionCreatedMs;

    if (recorded !== undefined && recorded !== null && live.sessionCreatedMs !== recorded) {
        return {
            kind: "skip",
            leftBehind: false,
            note: `tmux session ${session} is now a different session (created ${new Date(live.sessionCreatedMs).toISOString()}); it was not killed`,
        };
    }

    return { kind: "kill", target: live.sessionId ?? session };
}

/** The open record whose surface UUID is this live surface's, if any. A ref never decides: refs renumber after a restart. */
export function recordedSessionFor(
    open: readonly SessionCreatedRecord[],
    surfaceId: string
): SessionCreatedRecord | undefined {
    return open.find((record) => sameId(record.surfaceId, surfaceId));
}

export interface SessionCloseIO {
    store: SessionStore;
    listWorkspaces(window: string | null): Promise<ListedWorkspace[]>;
    /** A live agent session by session id (or 8+ char prefix), surface ref or workspace ref; null when none or several. */
    adopt?(query: string): Promise<AdoptedSession | null>;
    /** The UUID of the surface cmux lists at this ref now, or null when it lists none. */
    surfaceId(surface: string): Promise<string | null>;
    /** `surface` is a ref or a UUID (`surfaceTarget`); a UUID needs no window. */
    closeSurface(surface: string, window: string | null): Promise<void>;
    /** The workspace this command runs in (`CMUX_WORKSPACE_ID`), never closed. */
    callerWorkspaceId(): string | undefined;
    /**
     * The agent session in the record's surface and its turn state, or null when no hook recorded one.
     * `unreadable` means the lookup failed for a session that may exist (tmux did not answer, or a known session's
     * transcript could not be resolved or read): close then refuses like a running turn, because a busy agent
     * cannot be ruled out.
     */
    turnState(record: CloseSubject): Promise<TurnLookup | null>;
    sendExit(record: CloseSubject, text: string): Promise<void>;
    /** True while the agent still runs: a child of the recorded shell, or the agent's process on an adopted surface's tty. */
    agentRunning(record: CloseSubject): Promise<boolean>;
    /** `force`: the user passed --force, so cmux may kill a process that is still running there. */
    closeWorkspace(workspace: string, window: string | null, force: boolean): Promise<void>;
    /** Kill a tmux session; a session that is already gone counts as killed. */
    killTmux(session: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The panes of one tmux session (matched exactly), or why tmux did not answer. */
    tmuxPanes(session: string): Promise<TmuxListing<TmuxPaneInfo>>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

export type TurnLookup =
    | { kind: "read"; sessionId: string; state: string }
    | { kind: "unreadable"; sessionId: string | null; detail: string };

/**
 * The turn state of a known agent session. A transcript that cannot be resolved or read, or that gives no state,
 * is `unreadable`, never "unknown": close only types the exit into an agent whose turn it has seen end.
 */
export async function readTurnLookup<Agent extends string>(input: {
    sessionId: string;
    agent: Agent;
    transcriptOf: (sessionId: string, agent: Agent) => Promise<{ filePath: string }>;
    stateOf: (agent: Agent, filePath: string) => { state: string } | null;
}): Promise<TurnLookup> {
    const { sessionId, agent } = input;
    let filePath: string;

    try {
        filePath = (await input.transcriptOf(sessionId, agent)).filePath;
    } catch (error) {
        return { kind: "unreadable", sessionId, detail: `no transcript for ${sessionId}: ${errorText(error)}` };
    }

    try {
        const snapshot = input.stateOf(agent, filePath);
        return snapshot
            ? { kind: "read", sessionId, state: snapshot.state }
            : { kind: "unreadable", sessionId, detail: `the transcript ${filePath} gives no turn state` };
    } catch (error) {
        return {
            kind: "unreadable",
            sessionId,
            detail: `the transcript ${filePath} could not be read: ${errorText(error)}`,
        };
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
    | { kind: "record"; record: CloseSubject }
    | { kind: "bare"; workspace: string }
    | { kind: "none"; reason: "not-found" | "ambiguous" | "in-use"; note: string };

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

    return {
        kind: "none",
        reason: "not-found",
        note: `no open session named "${trimmed}" (see: ${toolCommand("cmux agents list", "--all")})`,
    };
}

function emptySteps(): CloseSteps {
    return { exitSent: false, agentExited: false, workspaceClosed: false, tmuxKilled: false };
}

/** cmux prints UUIDs upper-case and the journal may store them lower-case; a missing id never matches. */
function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
    return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

/** `check` runs before anything happens; `exit` right before the exit command is typed; `close` right before the workspace closes. */
type IdentityStage = "check" | "exit" | "close";

/**
 * Why a recorded session's refs may no longer name its own workspace and surface, or null when they do.
 *
 * cmux refs renumber after a restart, so `workspace:9` from an old record can name an unrelated workspace in
 * the same repo. The stored UUIDs decide: the workspace listed at the ref must carry the record's workspace
 * UUID, and the surface at the ref its surface UUID. A record without UUIDs (written before they were stored)
 * cannot be verified and is refused. A workspace that is no longer listed is not refused here: nothing at that
 * ref gets closed. Before the exit command is typed into a surface (not tmux), that surface must be listed.
 */
async function recordedIdentityProblem(input: {
    record: SessionCreatedRecord;
    stage: IdentityStage;
    window: string | null;
    io: Pick<SessionCloseIO, "listWorkspaces" | "surfaceId" | "tmuxPanes">;
}): Promise<{ reason: CloseReason; note: string } | null> {
    const { record, io } = input;
    const listed = (await io.listWorkspaces(input.window)).find((workspace) => workspace.ref === record.workspace);
    const holds = listed?.cwd ? ` (it holds ${listed.cwd})` : "";

    if (!record.workspaceId || !record.surfaceId) {
        return listed || input.stage === "exit"
            ? {
                  reason: "identity-unknown",
                  note: `${record.name} was recorded without cmux UUIDs, so after a cmux restart ${record.workspace}${holds} may be another session's workspace. Check it, then pass --force`,
              }
            : null;
    }

    if (listed && !sameId(listed.id, record.workspaceId)) {
        return {
            reason: "workspace-moved",
            note: `${record.workspace} is now another workspace${holds}; cmux refs renumber after a restart. Pass --force if it is the right one`,
        };
    }

    if (input.stage === "close") {
        return null;
    }

    const surfaceId = await io.surfaceId(record.surface);
    const typesIntoSurface = input.stage === "exit" && !record.tmuxSession;

    if (surfaceId === null ? typesIntoSurface : !sameId(surfaceId, record.surfaceId)) {
        return {
            reason: "workspace-moved",
            note: `${record.surface} is ${surfaceId === null ? "gone" : "now another surface"}, so the exit command has no safe target; cmux refs renumber after a restart. Pass --force if it is the right one`,
        };
    }

    return input.stage === "exit" ? tmuxPaneProblem(record, io) : null;
}

/**
 * Why an adopted session's surface ref no longer holds the surface it was adopted with, or null when it does.
 *
 * Adoption matched the journal's surface UUID once; a cmux restart during the turn check or the exit grace can
 * renumber the ref onto another terminal. So the UUID is checked again before every step that acts on it.
 */
async function adoptedIdentityProblem(
    record: AdoptedSession,
    stage: IdentityStage,
    io: Pick<SessionCloseIO, "surfaceId" | "tmuxPanes">
): Promise<{ reason: CloseReason; note: string } | null> {
    const live = await io.surfaceId(record.surface);

    if (live === null) {
        return { reason: "not-found", note: `${record.surface} is gone; the session is no longer open in cmux` };
    }

    if (!sameId(live, record.surfaceId)) {
        return {
            reason: "workspace-moved",
            note: `${record.surface} is now another surface, so nothing is typed into it or closed; cmux refs renumber after a restart`,
        };
    }

    // The surface only shows the tmux client: the pane the exit command is typed into is checked on its own.
    return stage === "close" ? null : tmuxPaneProblem(record, io);
}

/**
 * Close an agent session: quit the agent, then close its workspace (a session `agents new` opened) or its
 * surface (an adopted session, which may share the workspace with other panes).
 *
 * Order and refusals follow `GenesisBot/Common/Dev/proposals/cmux-session-close.md`. It never closes the
 * caller's own workspace, never a workspace with no recorded or adoptable agent unless `force`, never an agent
 * in the middle of a turn unless `force`, and never kills tmux unless `killTmux`. The transcript always stays.
 */
export async function closeSession(query: string, options: CloseOptions, io: SessionCloseIO): Promise<CloseReport> {
    const open = openSessions(io.store.read());
    let target = resolveCloseTarget(query, open);

    if (io.adopt && (target.kind === "bare" || (target.kind === "none" && target.reason === "not-found"))) {
        const adopted = await io.adopt(query.trim());
        // A session id that lives in a surface `agents new` opened closes as that recorded session. The surface
        // UUID decides, never the ref: after a restart a stale record's `surface:N` can name the adopted surface.
        const recorded = adopted ? recordedSessionFor(open, adopted.surfaceId) : undefined;

        if (adopted) {
            target = { kind: "record", record: recorded ?? adopted };
        }
    }

    // A recorded session closes under the same per-name reservation `agents new` starts it under: two closes, or a
    // close and a new start with the same name, never interleave.
    if (target.kind === "record" && !isAdopted(target.record)) {
        const name = target.record.name;
        const reserved = target;

        try {
            return await io.store.reserve(name, () => closeTarget({ query, target: reserved, options, io }));
        } catch (error) {
            if (!(error instanceof SessionNameBusyError)) {
                throw error;
            }

            return closeTarget({ query, target: { kind: "none", reason: "in-use", note: error.message }, options, io });
        }
    }

    return closeTarget({ query, target, options, io });
}

async function closeTarget(input: {
    query: string;
    target: Target;
    options: CloseOptions;
    io: SessionCloseIO;
}): Promise<CloseReport> {
    const { query, target, options, io } = input;
    const record = target.kind === "record" ? target.record : null;
    const adopted = record !== null && isAdopted(record);
    const report: CloseReport = {
        session: record?.name ?? query.trim(),
        agent: record?.agent ?? null,
        adopted,
        sessionId: record && isAdopted(record) ? record.sessionId : null,
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
            "not-recorded",
            `${target.workspace} has no session record and no agent session to adopt; pass --force to close the workspace anyway`
        );
    }

    // Read again under the reservation: another close may have finished this session while this one waited.
    if (
        record &&
        !isAdopted(record) &&
        !openSessions(io.store.read()).some(
            (entry) => entry.name === record.name && entry.createdAt === record.createdAt
        )
    ) {
        return refuse("not-found", `${record.name} was closed by another close meanwhile`);
    }

    const listed = (await io.listWorkspaces(report.window)).find((workspace) => workspace.ref === report.workspace);
    const caller = io.callerWorkspaceId();

    // An adopted session closes only its own surface, so sharing the caller's workspace is fine; `adopt`
    // never returns the caller's own surface.
    // `CMUX_WORKSPACE_ID` and `cmux workspace list` may print the same UUID in different cases.
    if (!adopted && listed && caller && sameId(listed.id, caller)) {
        return refuse("own-workspace", `${report.workspace} is the workspace this command runs in; it is never closed`);
    }

    // The refs are checked against the stored UUIDs here, and again right before the exit command is typed and
    // before the workspace or surface closes: refs renumber after a cmux restart. --force skips it for a recorded
    // session (its ref may be the right one after all), never for an adopted one: adoption found it by its UUID.
    const identityRefused = async (stage: IdentityStage): Promise<CloseReport | null> => {
        if (!record) {
            return null;
        }

        if (isAdopted(record)) {
            const moved = await adoptedIdentityProblem(record, stage, io);
            return moved ? refuse(moved.reason, moved.note) : null;
        }

        if (options.force) {
            return null;
        }

        const problem = await recordedIdentityProblem({ record, stage, window: report.window, io });
        return problem ? refuse(problem.reason, problem.note) : null;
    };
    const unverified = await identityRefused("check");

    if (unverified) {
        return unverified;
    }

    if (record) {
        const turn = await io.turnState(record);
        report.sessionId = turn?.sessionId ?? report.sessionId;
        report.turnState = turn ? (turn.kind === "read" ? turn.state : "UNREADABLE") : null;

        if (!turn) {
            report.notes.push("no agent session is recorded for this surface; the turn state is unknown");
        }

        if (turn?.kind === "unreadable" && !options.force) {
            return refuse(
                "turn-running",
                `the ${record.agent} turn state could not be read (${turn.detail}), so a running turn cannot be ruled out; retry, or pass --force`
            );
        }

        // STALLED is an unfinished turn that wrote nothing for a while: a long tool call looks the same, so it
        // is refused like RUNNING. Only --force quits an agent mid-turn.
        if (turn?.kind === "read" && (turn.state === "RUNNING" || turn.state === "STALLED") && !options.force) {
            const how =
                turn.state === "STALLED" ? "has not finished (stalled, possibly a long tool call)" : "is still running";
            return refuse(
                "turn-running",
                `the ${record.agent} turn ${how}; wait first: tools ${record.agent} wait ${turn.sessionId}, or pass --force`
            );
        }
    }

    if (options.dryRun) {
        report.outcome = "planned";
        report.notes.push(
            adopted && record
                ? `would quit the agent and close its surface ${record.surface} (the workspace stays)`
                : listed
                  ? `would quit the agent and close ${report.workspace}`
                  : `${report.workspace} is already gone`
        );
        return report;
    }

    // An adopted session's surface was checked live above; its workspace may sit in another window.
    if (record && (listed || adopted) && (await io.agentRunning(record))) {
        const beforeExit = await identityRefused("exit");

        if (beforeExit) {
            return beforeExit;
        }

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

    if ((adopted && record) || listed) {
        const beforeClose = await identityRefused("close");

        if (beforeClose) {
            return beforeClose;
        }
    }

    if (record && isAdopted(record)) {
        await io.closeSurface(surfaceTarget(record), null);
    } else if (listed) {
        await io.closeWorkspace(report.workspace, report.window, options.force === true);
    }

    const listedNow = async () =>
        record && isAdopted(record)
            ? sameId(await io.surfaceId(record.surface), record.surfaceId)
            : (await io.listWorkspaces(report.window)).some((workspace) => workspace.ref === report.workspace);
    const settleBy = io.now() + CLOSE_SETTLE_MS;
    let stillThere = await listedNow();

    while (stillThere && io.now() < settleBy) {
        await io.sleep(EXIT_POLL_MS);
        stillThere = await listedNow();
    }

    report.steps.workspaceClosed = !stillThere;

    let tmuxLeftBehind = false;

    if (record?.tmuxSession) {
        if (options.killTmux) {
            const target = await tmuxKillTarget(record, record.tmuxSession, io);

            if (target.kind === "kill") {
                const killed = await io.killTmux(target.target);
                report.steps.tmuxKilled = killed.ok;

                if (!killed.ok) {
                    tmuxLeftBehind = true;
                    report.notes.push(
                        `tmux session ${record.tmuxSession} may still run (${killed.reason}); end it with tmux kill-session -t ${record.tmuxSession}`
                    );
                }
            } else {
                tmuxLeftBehind = target.leftBehind;
                report.notes.push(target.note);
            }
        } else {
            // The closed record leaves the open list, so a second `close --kill-tmux` cannot find it: name tmux itself.
            report.notes.push(
                `tmux session ${record.tmuxSession} stays: tmux attach -t ${record.tmuxSession}, or end it with tmux kill-session -t ${record.tmuxSession}`
            );
        }
    }

    // A requested tmux kill that failed is not a full close: the record stays open, so a second close can finish it.
    report.outcome = report.steps.workspaceClosed && !tmuxLeftBehind ? "closed" : "partial";

    // A partial close keeps the record open, so a second `close` can finish the job.
    if (record && !isAdopted(record) && report.outcome === "closed") {
        io.store.append({
            type: "closed",
            name: record.name,
            createdAt: record.createdAt,
            closedAt: new Date(io.now()).toISOString(),
            outcome: report.outcome,
            steps: { ...report.steps },
        });
    }

    return report;
}
