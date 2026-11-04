// The agents board wire (F9, F19): the live sessions with their phase, the `agents` live channel's frames, a
// transcript page and the stop receipt. Types only, written here rather than imported from the hub lib, so the phone's
// `tsc` never walks the server tree (`contract-purity.test.ts`). `src/hub/lib/board` returns these shapes.

/** The harness of a session: the provider alias the fleet view uses. */
export type AgentBoardProvider = "claude" | "codex" | "grok";

/** The fleet phase of a session (`FLEET_PHASES` in `@genesiscz/utils/ai/live-sessions/phase`). */
export type AgentBoardPhase = "thinking" | "tool" | "waiting" | "idle" | "interrupted";

/** The word a board shows: a phase, `stalled` for a running turn that went silent, `unknown` with no transcript. */
export type AgentBoardLabel = AgentBoardPhase | "stalled" | "unknown";

/** The hub's stuck verdict for a running turn: a call that waits too long, or a loop. */
export interface AgentBoardStuck {
    kind: string;
    detail: string;
}

/** What one live session does now. The `agents` channel carries this per session. */
export interface AgentBoardPhaseRow {
    /** Stable for the life of the session: `<provider>:<session id>`, or `<provider>:pid:<pid>` without an id. */
    key: string;
    provider: AgentBoardProvider;
    sessionId: string | null;
    phase: AgentBoardPhase | null;
    label: AgentBoardLabel;
    stalled: boolean;
    stuck: AgentBoardStuck | null;
    /** The agent process; the stop action names it so a reused pid is refused. Null for a surface without a pid. */
    pid: number | null;
    /** Epoch ms the transcript was last written. */
    lastActivityAt: number | null;
}

/** A sub-agent, teammate or worker, folded under the session that started it. */
export interface AgentBoardChild {
    id: string;
    harness: string;
    kind: string;
    /** A teammate's name, else the Agent call's description, else the agent type. */
    name: string | null;
    model: string | null;
    /** `running`, `idle`, `completed`, `failed` or `killed` (the hub agent status). */
    status: string;
    lastAt: string;
    /**
     * When this child is itself a live session on the board (a codex or grok worker in its own process): its phase
     * label. The session is folded here and is not listed again at the top level.
     */
    liveLabel: AgentBoardLabel | null;
    children: AgentBoardChild[];
}

export interface AgentBoardSession extends AgentBoardPhaseRow {
    /** The project folder's name, else the last part of the working directory. */
    project: string | null;
    cwd: string | null;
    account: string | null;
    model: string | null;
    title: string | null;
    /** The newest prompt, folded to one line and clipped on the Mac (`BOARD_TEXT_CHARS`, `src/hub/lib/board`). */
    lastPrompt: string | null;
    /** The newest assistant text, clipped like the prompt. */
    lastText: string | null;
    children: AgentBoardChild[];
}

export interface AgentsBoardDto {
    generatedAt: string;
    sessions: AgentBoardSession[];
}

/** One turn of a transcript page, as the gateway's transcript route sends it (tool results are clipped there). */
export interface AgentTranscriptTurnDto {
    id: string;
    role: "user" | "assistant" | "system";
    at: string | null;
    text: string;
    tools: Array<{ id: string; name: string; inputPreview: string; result: string | null; isError: boolean }>;
}

/** The newest turns of a session (`GET /api/gateway/transcript?query=<id>&limit=<n>`, a bounded tail). */
export interface AgentTranscriptDto {
    provider: AgentBoardProvider;
    sessionId: string;
    truncated: boolean;
    turns: AgentTranscriptTurnDto[];
}

/** `POST /api/agents/stop`: end one live session's process tree. */
export interface AgentStopInput {
    key: string;
    /** The pid the board showed; a session whose process changed since is refused. */
    pid: number;
}

export interface AgentStopReceiptDto {
    key: string;
    pid: number;
    stopped: boolean;
    /** The strongest signal that was needed, or null when nothing was sent. */
    signal: "TERM" | "KILL" | null;
    /** Pids still alive at the end. */
    survivors: number[];
    /** Why nothing was sent, or what went wrong. */
    reason: string | null;
}
