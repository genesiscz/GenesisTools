import {
    CancelledError,
    InvalidStatusError,
    NotCancellableError,
    NotUndoableError,
} from "@app/dev-dashboard/lib/boards/annotations-store";
import { SlugConflictError } from "@app/dev-dashboard/lib/boards/boards-store";
import { NameConflictError, NotFoundError } from "@app/dev-dashboard/lib/boards/sets-store";
import type { RouteResult } from "@app/dev-dashboard/server/types";
import { errorResult } from "./error";

export function boardsError(err: unknown): RouteResult {
    if (err instanceof NotFoundError) {
        return { kind: "json", status: 404, body: { error: err.message || "not found" } };
    }
    if (err instanceof CancelledError) {
        return { kind: "json", status: 409, body: { error: "annotation cancelled", code: "cancelled" } };
    }
    if (err instanceof NotCancellableError) {
        return { kind: "json", status: 409, body: { error: "not cancellable", code: "not_cancellable" } };
    }
    if (err instanceof NotUndoableError) {
        return { kind: "json", status: 409, body: { error: "not undoable", code: "not_undoable" } };
    }
    if (err instanceof NameConflictError || err instanceof SlugConflictError) {
        return { kind: "json", status: 409, body: { error: err.message || "conflict", code: "conflict" } };
    }
    if (err instanceof InvalidStatusError) {
        return { kind: "json", status: 400, body: { error: err.message || "invalid status" } };
    }
    return errorResult(err);
}
