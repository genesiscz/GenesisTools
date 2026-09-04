/**
 * The shared event vocabulary for external AI workers (codex, grok, claude).
 *
 * Rule: the TRANSPORT is unified here; the PERMISSION MODEL is not. Backends
 * differ on approvals and sandboxing on purpose — those differences live in
 * `./capabilities` and callers must branch on them, never paper over them.
 *
 * Fields are backend-neutral: `sessionId` is whatever identity the backend
 * keys a conversation by (codex thread id, grok session uuid, claude session
 * uuid). Backend-specific ids appear only where a variant exists to carry
 * them (`approval_request.requestId` feeds `tools codex approve`).
 */

export interface WorkerUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
    totalCostUsd?: number;
}

export type WorkerEvent =
    | { kind: "turn.started"; sessionId: string; turn?: number; ts?: string }
    | { kind: "text"; sessionId: string; text: string; delta: boolean; ts?: string }
    | { kind: "reasoning"; sessionId: string; text: string; delta: boolean; ts?: string }
    | { kind: "tool_call"; sessionId: string; tool: string; target?: string; callId?: string; ts?: string }
    | {
          kind: "tool_result";
          sessionId: string;
          tool?: string;
          callId?: string;
          output?: string;
          ok?: boolean;
          ts?: string;
      }
    | { kind: "approval_request"; sessionId: string; requestId: string; method: string; detail?: string; ts?: string }
    | { kind: "turn.completed"; sessionId: string; turn?: number; usage?: WorkerUsage; ts?: string }
    | { kind: "turn.failed"; sessionId: string; reason?: string; ts?: string }
    /**
     * A live rate-limit push from the backend (codex `account/rateLimits/updated`). The
     * payload stays provider-native: `src/utils/ai/usage-poll` owns the mapping into
     * `LimitWindow[]`, and a worker must not depend on that vocabulary.
     */
    | { kind: "usage.limits"; sessionId: string; native: unknown; ts?: string }
    | { kind: "error"; sessionId: string; message: string; ts?: string }
    | { kind: "session.closed"; sessionId: string; ts?: string };

export type WorkerEventKind = WorkerEvent["kind"];

function is<K extends WorkerEventKind>(kind: K) {
    return (event: WorkerEvent): event is Extract<WorkerEvent, { kind: K }> => event.kind === kind;
}

export const isTurnStarted = is("turn.started");
export const isText = is("text");
export const isReasoning = is("reasoning");
export const isToolCall = is("tool_call");
export const isToolResult = is("tool_result");
export const isApprovalRequest = is("approval_request");
export const isTurnCompleted = is("turn.completed");
export const isTurnFailed = is("turn.failed");
export const isUsageLimits = is("usage.limits");
export const isWorkerError = is("error");
export const isSessionClosed = is("session.closed");

/**
 * Fold streamed deltas into whole messages before a line-per-event printer sees
 * them. A run of `text` or `reasoning` deltas becomes ONE non-delta event with
 * the joined text. When the run is immediately followed by a non-delta event of
 * the same kind (codex emits the per-token deltas AND the completed message),
 * the run is dropped and the completed message stands alone, so nothing prints
 * twice. Grok emits deltas only, and its `read --events` used to print one line
 * per token (233 lines for a 65-call turn, 2026-09-04).
 */
export function coalesceWorkerEvents(events: readonly WorkerEvent[]): WorkerEvent[] {
    interface Run {
        kind: "text" | "reasoning";
        sessionId: string;
        text: string;
        ts?: string;
    }

    const whole = (run: Run): WorkerEvent => ({
        kind: run.kind,
        sessionId: run.sessionId,
        text: run.text,
        delta: false,
        ...(run.ts ? { ts: run.ts } : {}),
    });

    const out: WorkerEvent[] = [];
    let run: Run | null = null;

    for (const event of events) {
        if ((event.kind === "text" || event.kind === "reasoning") && event.delta) {
            if (run !== null && run.kind === event.kind) {
                run.text += event.text;
            } else {
                if (run !== null) {
                    out.push(whole(run));
                }

                run = { kind: event.kind, sessionId: event.sessionId, text: event.text, ts: event.ts };
            }

            continue;
        }

        if (run !== null && event.kind !== run.kind) {
            out.push(whole(run));
        }

        // A completed message of the same kind supersedes the deltas that streamed it.
        run = null;
        out.push(event);
    }

    if (run !== null) {
        out.push(whole(run));
    }

    return out;
}

/** One-line human rendering, shared so every backend's `--events` view reads the same. */
export function formatWorkerEvent(event: WorkerEvent): string {
    switch (event.kind) {
        case "turn.started":
            return `▶ turn ${event.turn ?? "?"} started`;
        case "text":
            return event.delta ? event.text : `💬 ${event.text}`;
        case "reasoning":
            return event.delta ? "" : `🧠 ${event.text}`;
        case "tool_call":
            return `🔧 ${event.tool}${event.target ? ` ${event.target}` : ""}`;
        case "tool_result":
            return `↩ ${event.tool ?? event.callId ?? "tool"}${event.ok === false ? " FAILED" : ""}`;
        case "approval_request":
            return `⏸ approval needed [${event.requestId}] ${event.method}${event.detail ? ` — ${event.detail}` : ""}`;
        case "turn.completed":
            return `✔ turn ${event.turn ?? "?"} completed${
                event.usage?.totalCostUsd !== undefined ? ` ($${event.usage.totalCostUsd.toFixed(4)})` : ""
            }`;
        case "turn.failed":
            return `✖ turn failed${event.reason ? `: ${event.reason}` : ""}`;
        case "usage.limits":
            return "📊 rate limits updated";
        case "error":
            return `✖ error: ${event.message}`;
        case "session.closed":
            return "■ session closed";
    }
}
