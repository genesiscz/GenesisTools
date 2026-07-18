import { SafeJSON } from "@app/utils/json";

export type CodexControl =
    | { op: "steer"; body: string; force: boolean }
    | { op: "interrupt" }
    | { op: "rollback"; turns: number }
    | { op: "read" }
    | { op: "review"; base?: string; scope?: "auto" | "working-tree" | "branch"; adversarial?: string[] }
    | { op: "approve" | "deny"; requestId: string }
    | { op: "stop" };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRequestId(value: unknown): string {
    if (typeof value !== "string" || !value) {
        throw new Error("requestId is required");
    }

    return value;
}

function rollbackTurns(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error("rollback turns must be at least 1");
    }

    return value;
}

function parseStructuredControl(value: Record<string, unknown>): CodexControl {
    switch (value.op) {
        case "steer":
            if (typeof value.body !== "string" || !value.body.trim()) {
                throw new Error("steer body is required");
            }

            return { op: "steer", body: value.body, force: Boolean(value.force) };
        case "interrupt":
            return { op: "interrupt" };
        case "rollback":
            return { op: "rollback", turns: rollbackTurns(value.turns) };
        case "read":
            return { op: "read" };
        case "review": {
            const scope = value.scope ?? "auto";
            if (scope !== "auto" && scope !== "working-tree" && scope !== "branch") {
                throw new Error(`Unsupported review scope: ${String(scope)}`);
            }

            const adversarial =
                value.adversarial === true
                    ? []
                    : Array.isArray(value.adversarial)
                      ? value.adversarial.filter((focus): focus is string => typeof focus === "string")
                      : undefined;
            return {
                op: "review",
                scope,
                ...(typeof value.base === "string" ? { base: value.base } : {}),
                ...(adversarial ? { adversarial } : {}),
            };
        }
        case "approve":
        case "deny":
            return { op: value.op, requestId: requiredRequestId(value.requestId) };
        case "stop":
            return { op: "stop" };
        default:
            throw new Error(`Unsupported control op: ${String(value.op)}`);
    }
}

export function parseControlBody(body: string): CodexControl {
    const trimmed = body.trim();
    if (!trimmed) {
        throw new Error("Control body is empty");
    }

    if (trimmed === "/interrupt") {
        return { op: "interrupt" };
    }

    if (trimmed === "/stop") {
        return { op: "stop" };
    }

    const rollback = trimmed.match(/^\/rollback(?:\s+(\d+))?$/);
    if (rollback) {
        return { op: "rollback", turns: rollbackTurns(Number(rollback[1] ?? "1")) };
    }

    if (trimmed.startsWith("{")) {
        const parsed = SafeJSON.parse(trimmed, { strict: true });
        if (!isRecord(parsed)) {
            throw new Error("Structured control body must be an object");
        }

        return parseStructuredControl(parsed);
    }

    return { op: "steer", body, force: false };
}
