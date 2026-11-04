import {
    type AgentBoardPhaseRow,
    type AgentBoardSession,
    type AgentStopInput,
    type AgentStopReceiptDto,
    type AgentsBoardDto,
    type AgentTranscriptDto,
    type AgentTranscriptTurnDto,
    type DashboardClient,
    ENDPOINTS,
} from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const agentsKeys = {
    board: ["agents", "board"] as const,
    transcript: (key: string) => ["agents", "transcript", key] as const,
};

/** The board's poll while the `agents` channel is not live (the stream is down or the tier cannot stream). */
export const BOARD_INTERVAL_MS = 15_000;
/**
 * The open transcript's poll. No channel carries transcript text (the `agents` channel carries phases), so the
 * session view tails by polling the bounded newest turns while it is on screen.
 */
export const TRANSCRIPT_INTERVAL_MS = 4_000;
/** How many of the newest turns the session view asks for; the Mac reads only the end of the transcript for them. */
export const TRANSCRIPT_TURNS = 40;

export function boardQuery(client: DashboardClient) {
    return queryOptions<AgentsBoardDto>({
        queryKey: agentsKeys.board,
        queryFn: () => client.call(ENDPOINTS.gatewayBoard, {}),
        refetchInterval: BOARD_INTERVAL_MS,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function turnOf(value: unknown): AgentTranscriptTurnDto | null {
    if (!isRecord(value)) {
        return null;
    }

    const role = value.role === "user" || value.role === "assistant" || value.role === "system" ? value.role : null;

    if (!role) {
        return null;
    }

    const tools = Array.isArray(value.tools) ? value.tools.filter(isRecord) : [];
    return {
        id: text(value.id),
        role,
        at: typeof value.at === "string" ? value.at : null,
        text: text(value.text),
        tools: tools.map((tool) => ({
            id: text(tool.id),
            name: text(tool.name),
            inputPreview: text(tool.inputPreview),
            result: typeof tool.result === "string" ? tool.result : null,
            isError: tool.isError === true,
        })),
    };
}

/** The transcript route answers the hub's envelope; this keeps the fields the session view shows. */
export function asTranscript(value: unknown, session: Pick<AgentBoardSession, "provider">): AgentTranscriptDto {
    if (!isRecord(value)) {
        return { provider: session.provider, sessionId: "", truncated: false, turns: [] };
    }

    const turns = Array.isArray(value.turns) ? value.turns.map(turnOf) : [];
    return {
        provider: session.provider,
        sessionId: text(value.sessionId),
        truncated: value.truncated === true,
        turns: turns.filter((turn): turn is AgentTranscriptTurnDto => turn !== null),
    };
}

/** The newest turns of one session. A session without an id has no transcript the Mac can find. */
export function transcriptQuery(
    client: DashboardClient,
    session: Pick<AgentBoardSession, "key" | "sessionId" | "provider">
) {
    return queryOptions<AgentTranscriptDto>({
        queryKey: agentsKeys.transcript(session.key),
        queryFn: async () =>
            asTranscript(
                await client.call(ENDPOINTS.gatewayTranscript, {
                    query: session.sessionId ?? "",
                    provider: session.provider,
                    limit: TRANSCRIPT_TURNS,
                }),
                session
            ),
        enabled: session.sessionId !== null,
        refetchInterval: TRANSCRIPT_INTERVAL_MS,
    });
}

export function stopSession(
    client: DashboardClient,
    input: AgentStopInput & { idempotencyKey: string }
): Promise<AgentStopReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.agentsStop, body, { idempotencyKey });
}

/** A `phase` frame merged into the board; undefined when the board does not hold that session (refetch it). */
export function withPhase(board: AgentsBoardDto | undefined, row: AgentBoardPhaseRow): AgentsBoardDto | undefined {
    if (!board || !board.sessions.some((session) => session.key === row.key)) {
        return undefined;
    }

    return {
        ...board,
        sessions: board.sessions.map((session) => (session.key === row.key ? { ...session, ...row } : session)),
    };
}

/** A `snapshot` frame merged into the board; undefined when a session started or ended (refetch the board). */
export function withPhases(
    board: AgentsBoardDto | undefined,
    rows: readonly AgentBoardPhaseRow[]
): AgentsBoardDto | undefined {
    if (!board) {
        return undefined;
    }

    const byKey = new Map(rows.map((row) => [row.key, row]));
    const same = board.sessions.length === rows.length && board.sessions.every((session) => byKey.has(session.key));

    if (!same) {
        return undefined;
    }

    return { ...board, sessions: board.sessions.map((session) => ({ ...session, ...byKey.get(session.key) })) };
}
