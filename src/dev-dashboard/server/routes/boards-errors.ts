import {
    CancelledError,
    InvalidStatusError,
    NotCancellableError,
    NotUndoableError,
} from "@app/dev-dashboard/lib/boards/annotations-store";
import { InvalidInputError, SlugConflictError } from "@app/dev-dashboard/lib/boards/boards-store";
import { NameConflictError, NotFoundError } from "@app/dev-dashboard/lib/boards/sets-store";
import type { RouteResult } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";
import { errorResult } from "./error";

/** Every boards route funnels its catch through here — the one place that sees ALL failures. */
export function boardsError(err: unknown): RouteResult {
    if (err instanceof NotFoundError) {
        logger.debug({ err: err.message }, "boards error: not found");
        return { kind: "json", status: 404, body: { error: err.message || "not found" } };
    }
    if (err instanceof CancelledError) {
        logger.info({ err: err.message }, "boards error: write against a cancelled annotation");
        return { kind: "json", status: 409, body: { error: "annotation cancelled", code: "cancelled" } };
    }
    if (err instanceof NotCancellableError) {
        logger.debug({ err: err.message }, "boards error: not cancellable");
        return { kind: "json", status: 409, body: { error: "not cancellable", code: "not_cancellable" } };
    }
    if (err instanceof NotUndoableError) {
        logger.debug({ err: err.message }, "boards error: not undoable");
        return { kind: "json", status: 409, body: { error: "not undoable", code: "not_undoable" } };
    }
    if (err instanceof NameConflictError || err instanceof SlugConflictError) {
        logger.info({ err: err.message }, "boards error: name/slug conflict");
        return { kind: "json", status: 409, body: { error: err.message || "conflict", code: "conflict" } };
    }
    if (err instanceof InvalidStatusError) {
        logger.warn({ err: err.message }, "boards error: invalid status transition");
        return { kind: "json", status: 400, body: { error: err.message || "invalid status" } };
    }
    if (err instanceof InvalidInputError) {
        logger.warn({ err: err.message }, "boards error: invalid input");
        return { kind: "json", status: 400, body: { error: err.message } };
    }
    logger.error({ err }, "boards error: unhandled — returning 500");
    return errorResult(err);
}
