import { Buffer } from "node:buffer";
import type { AsyncQueue } from "./async-queue";

/**
 * Durable operation values, ported from `harness/operation`. The actor runtime that executes
 * them is NOT ported: the host (Pi's tool runner) implements `Manager`.
 */

export type OperationType = string;
export type OperationVersion = number;
export type OperationID = string;

export type Status = "ready" | "awaiting" | "canceling" | "completed" | "failed" | "canceled";

/** `State` and `Idempotency` are raw JSON text, as the Go `jsontext.Value`. */
export interface Spec {
    MaxOutputLength?: number;
    Type: OperationType;
    Version: OperationVersion;
    State?: string;
    Idempotency?: string;
}

export interface Operation {
    MaxOutputLength?: number;
    ID: OperationID;
    Type: OperationType;
    Version: OperationVersion;
    Status: Status;
    State?: string;
    Idempotency?: string;
}

export class UnsupportedOperationError extends Error {
    constructor(message = "unsupported operation") {
        super(message);
        this.name = "UnsupportedOperationError";
    }
}

export interface Manager {
    /** Starts an operation at most once per id for the manager's lifetime. Throws `UnsupportedOperationError` when it cannot. */
    add(operation: Operation): Promise<void> | void;
    cancel(id: OperationID, reason: string): Promise<void> | void;
    updates(): AsyncQueue<Operation>;
}

export function isTerminal(status: Status): boolean {
    return status === "completed" || status === "failed" || status === "canceled";
}

export const DEFAULT_MAX_OUTPUT_LENGTH = 40_000;
export const MAX_OUTPUT_LENGTH = 1_000_000;

function runes(text: string): string[] {
    return Array.from(text);
}

/**
 * Keep at most `limit` characters of `text`: half from the head, half from the tail, with a
 * marker naming how many bytes fell out. Returns whether anything was cut.
 */
export function boundOutput(text: string, limit: number): [string, boolean] {
    const cap = Math.max(0, limit);
    const chars = runes(text);

    if (chars.length <= cap) {
        return [text, false];
    }

    const headCount = Math.floor(cap / 2);
    const tailCount = cap - headCount;
    const head = chars.slice(0, headCount).join("");
    const tail = tailCount > 0 ? chars.slice(chars.length - tailCount).join("") : "";
    const skipped = Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail);
    return [`${head}...${skipped} bytes truncated...${tail}`, true];
}
