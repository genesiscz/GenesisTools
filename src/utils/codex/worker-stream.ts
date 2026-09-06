import { logger } from "@genesiscz/utils/logger";
import { formatWorkerEvent, type WorkerEvent } from "@genesiscz/utils/worker/events";

const log = logger.child({ component: "codex:adapter" });

/**
 * A stored session-log line: the envelope `CodexSessionStore.appendEvent`
 * writes (`source` daemon | app-server | control, plus the raw notification).
 * `params` is `unknown` to match `CodexEventRecord`; the adapter narrows it.
 */
export interface StoredCodexEvent {
    source?: string;
    method?: string;
    params?: unknown;
    seq?: number;
    ts?: string;
}

function paramsOf(event: StoredCodexEvent): Record<string, unknown> | undefined {
    const { params } = event;
    if (params && typeof params === "object" && !Array.isArray(params)) {
        return params as Record<string, unknown>;
    }

    return undefined;
}

interface CodexItem {
    type?: string;
    id?: string;
    text?: string;
    command?: string;
    exitCode?: number | null;
    status?: string;
    aggregatedOutput?: string | null;
    changes?: Array<{ path?: string }>;
    content?: Array<{ type?: string; text?: string }>;
    server?: string;
    tool?: string;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function sessionIdOf(params: Record<string, unknown> | undefined): string {
    return str(params?.threadId) ?? str((params?.thread as { id?: unknown } | undefined)?.id) ?? "";
}

function itemOf(params: Record<string, unknown> | undefined): CodexItem | undefined {
    const item = params?.item;
    if (item && typeof item === "object" && !Array.isArray(item)) {
        return item as CodexItem;
    }

    return undefined;
}

function toolCallOf(item: CodexItem, sessionId: string, ts?: string): WorkerEvent | null {
    switch (item.type) {
        case "commandExecution":
            return { kind: "tool_call", sessionId, tool: "command", target: item.command, callId: item.id, ts };
        case "fileChange":
            return {
                kind: "tool_call",
                sessionId,
                tool: "file_change",
                target: item.changes?.map((c) => c.path).join(", "),
                callId: item.id,
                ts,
            };
        case "mcpToolCall":
            return {
                kind: "tool_call",
                sessionId,
                tool: [item.server, item.tool].filter(Boolean).join("."),
                callId: item.id,
                ts,
            };
        default:
            return null;
    }
}

/**
 * Map one stored codex event onto the shared worker vocabulary.
 *
 * Returns null for lines that are deliberately not part of the shared stream
 * (MCP startup chatter, hook lifecycles, token/rate-limit bookkeeping, control
 * echoes); unknown methods are also null but logged at debug so a protocol
 * addition never disappears silently.
 */
export function toWorkerEvent(event: StoredCodexEvent): WorkerEvent | null {
    const { method, ts } = event;
    const params = paramsOf(event);
    const sessionId = sessionIdOf(params);

    if (event.source === "daemon" && method === "approval_request") {
        return {
            kind: "approval_request",
            sessionId,
            requestId: str(params?.requestId) ?? "",
            method: str(params?.method) ?? "",
            detail: str(params?.detail),
            ts,
        };
    }

    switch (method) {
        case "turn/started":
            return { kind: "turn.started", sessionId, ts };
        case "turn/completed": {
            const turn = params?.turn as { status?: string; error?: unknown } | undefined;
            if (turn?.status === "failed" || turn?.error) {
                return { kind: "turn.failed", sessionId, reason: str(turn?.error) ?? turn?.status, ts };
            }

            return { kind: "turn.completed", sessionId, ts };
        }
        case "turn/failed":
            return { kind: "turn.failed", sessionId, reason: str(params?.error) ?? str(params?.message), ts };
        case "item/agentMessage/delta":
            return { kind: "text", sessionId, text: str(params?.delta) ?? "", delta: true, ts };
        case "item/started": {
            const item = itemOf(params);
            return item ? toolCallOf(item, sessionId, ts) : null;
        }
        case "item/completed": {
            const item = itemOf(params);
            if (!item) {
                return null;
            }

            switch (item.type) {
                case "agentMessage":
                    return { kind: "text", sessionId, text: item.text ?? "", delta: false, ts };
                case "reasoning": {
                    const text = item.content?.map((c) => c.text ?? "").join("") ?? "";
                    return { kind: "reasoning", sessionId, text, delta: false, ts };
                }
                case "userMessage":
                    return null;
                case "commandExecution":
                    return {
                        kind: "tool_result",
                        sessionId,
                        tool: "command",
                        callId: item.id,
                        // `exitCode` is optional in practice: an item/completed
                        // for a cancelled or still-settling command omits it,
                        // and `undefined === 0` rendered "command FAILED" for a
                        // command that did not fail. Fall back to `status`, as
                        // the fileChange and mcpToolCall cases do.
                        ok: typeof item.exitCode === "number" ? item.exitCode === 0 : item.status !== "failed",
                        output: item.aggregatedOutput ?? undefined,
                        ts,
                    };
                case "fileChange":
                    return {
                        kind: "tool_result",
                        sessionId,
                        tool: "file_change",
                        callId: item.id,
                        ok: item.status !== "failed",
                        ts,
                    };
                case "mcpToolCall":
                    return {
                        kind: "tool_result",
                        sessionId,
                        tool: [item.server, item.tool].filter(Boolean).join("."),
                        callId: item.id,
                        ok: item.status !== "failed",
                        ts,
                    };
                default:
                    log.debug({ itemType: item.type }, "unmapped codex item type");
                    return null;
            }
        }
        case "error":
            return { kind: "error", sessionId, message: str(params?.message) ?? "unknown codex error", ts };
        case "thread/status/changed": {
            const status = params?.status as { type?: string } | undefined;
            return status?.type === "closed" ? { kind: "session.closed", sessionId, ts } : null;
        }
        // A running `tools codex run` gets fresh rate limits pushed for free, so the
        // openai-sub usage cache can refresh without spawning a second app-server
        // (spec 2026-09-04 section 6.6). The payload is passed through untouched.
        case "account/rateLimits/updated":
            return { kind: "usage.limits", sessionId, native: params, ts };
        // Deliberately outside the shared stream.
        case "daemon/started":
        case "thread/started":
        case "mcpServer/startupStatus/updated":
        case "hook/started":
        case "hook/completed":
        case "thread/tokenUsage/updated":
        case "remoteControl/status/changed":
        case "skills/changed":
        case "warning":
        case "configWarning":
        case "turn/diff/updated":
        case "item/commandExecution/outputDelta":
            return null;
        default:
            if (event.source === "control") {
                return null;
            }

            log.debug({ method }, "unmapped codex notification method");
            return null;
    }
}

/**
 * The `--events` line for one stored notification, or "" when it prints nothing.
 *
 * Shared by `tail --events` and `logs --events` so the two views cannot drift.
 * Text DELTAS are dropped here: codex emits both the per-token deltas and the
 * completed agentMessage, and a line-per-event printer rendered every answer
 * once token by token and then again in full.
 */
export function formatStoredEventLine(stored: StoredCodexEvent): string {
    const event = toWorkerEvent(stored);

    if (!event || (event.kind === "text" && event.delta)) {
        return "";
    }

    return formatWorkerEvent(event);
}
