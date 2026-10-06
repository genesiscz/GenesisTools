import type { RpcNotification } from "./app-server-client";

export type CodexTurnOutcome = "completed" | "failed" | "interrupted";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
    if (!isRecord(value)) {
        return null;
    }

    const nested = value[key];
    return isRecord(nested) ? nested : null;
}

export function codexTurnOutcome(notification: RpcNotification): {
    outcome: CodexTurnOutcome;
    turnId?: string;
    detail?: unknown;
} | null {
    if (notification.method === "turn/failed") {
        const turn = nestedRecord(notification.params, "turn");
        const params = isRecord(notification.params) ? notification.params : null;

        return {
            outcome: "failed",
            ...(typeof turn?.id === "string" ? { turnId: turn.id } : {}),
            detail: turn?.error ?? params?.error ?? notification.params,
        };
    }

    if (notification.method !== "turn/completed") {
        return null;
    }

    const turn = nestedRecord(notification.params, "turn");
    const status = turn?.status;
    const outcome: CodexTurnOutcome =
        status === "failed" || turn?.error ? "failed" : status === "interrupted" ? "interrupted" : "completed";

    return {
        outcome,
        ...(typeof turn?.id === "string" ? { turnId: turn.id } : {}),
        ...(turn?.error === undefined ? {} : { detail: turn.error }),
    };
}
