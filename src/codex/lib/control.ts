import { isAbsolute } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export interface CodexControlTarget {
    threadId: string;
    home: string;
}

export type CodexControl =
    | { op: "steer"; body: string; force: boolean; expectedTarget?: CodexControlTarget }
    | { op: "interrupt" }
    | { op: "rollback"; turns: number }
    | { op: "read" }
    | { op: "review"; base?: string; scope?: "auto" | "working-tree" | "branch"; adversarial?: string[] }
    | { op: "approve"; requestId: string }
    | { op: "deny"; requestId: string; refusal?: ApprovalRefusal }
    | { op: "stop" };

/**
 * Who declined a worker's request and why. Codex itself tells the worker only `Rejected("rejected by user")`, so on
 * 2026-10-27 a lead's quality refusal read as a human permission decision and the worker stopped that line of work.
 * `parent` is the supervising session, `human` a person at the dashboard or CLI, `policy` the session's own
 * write policy. A refusal with a reason is also steered to the worker in words, naming the actor.
 */
export interface ApprovalRefusal {
    by: ApprovalActor;
    reason?: string;
}

export type ApprovalActor = "parent" | "human" | "policy";

export const APPROVAL_ACTORS: readonly ApprovalActor[] = ["parent", "human", "policy"];

/** The words the worker gets after a non-human refusal, so it knows who declined and what to change. */
export function refusalNotice(requestId: string, refusal: ApprovalRefusal): string {
    const actor =
        refusal.by === "parent"
            ? "the parent session that supervises you, not a human"
            : "this session's write policy, not a human";
    const reason = refusal.reason ? ` Reason: ${refusal.reason}` : "";

    return `Request ${requestId} was declined by ${actor}. Codex reports it as "rejected by user"; treat it as the lead's guidance, not as a permission decision: fix what the reason names and continue.${reason}`;
}

export function parseApprovalRefusal(value: unknown): ApprovalRefusal | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!isRecord(value) || typeof value.by !== "string" || !APPROVAL_ACTORS.includes(value.by as ApprovalActor)) {
        throw new Error(`refusal.by must be one of ${APPROVAL_ACTORS.join(", ")}`);
    }

    const reason = value.reason;

    if (reason !== undefined && typeof reason !== "string") {
        throw new Error("refusal.reason must be a string");
    }

    return { by: value.by as ApprovalActor, ...(reason ? { reason } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseControlTarget(value: unknown): CodexControlTarget {
    if (
        !isRecord(value) ||
        typeof value.threadId !== "string" ||
        !value.threadId.trim() ||
        typeof value.home !== "string" ||
        !value.home.trim() ||
        !isAbsolute(value.home)
    ) {
        throw new Error("An expected Codex target requires an exact thread and absolute source home.");
    }

    return { threadId: value.threadId, home: value.home };
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
        case "steer": {
            if (typeof value.body !== "string" || !value.body.trim()) {
                throw new Error("steer body is required");
            }

            return {
                op: "steer",
                body: value.body,
                force: Boolean(value.force),
                ...(value.expectedTarget === undefined
                    ? {}
                    : { expectedTarget: parseControlTarget(value.expectedTarget) }),
            };
        }
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
            return { op: "approve", requestId: requiredRequestId(value.requestId) };
        case "deny": {
            const refusal = parseApprovalRefusal(value.refusal);
            return { op: "deny", requestId: requiredRequestId(value.requestId), ...(refusal ? { refusal } : {}) };
        }
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
