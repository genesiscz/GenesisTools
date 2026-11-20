import type { DeliveryResult } from "./deliver";

// The delivery errors on their own: `read.ts` checks them, and importing `deliver.ts` for two classes pulled the cmux
// and codex delivery modules into every reader of the decision log.

/** The transport was attempted but its receipt was lost; never put it back on an automatic send queue. */
export class DeliveryUnknownError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DeliveryUnknownError";
    }
}

/**
 * The answers reached the agent, then recording their delivery failed. Unlike `DeliveryUnknownError` the transport's
 * receipt is in hand: a Send again would type them a second time. The record's own error is the `cause`.
 */
export class DeliveredUnrecordedError extends Error {
    constructor(
        readonly route: DeliveryResult,
        cause: unknown
    ) {
        super(
            `The answers reached the agent, but recording their delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause }
        );
        this.name = "DeliveredUnrecordedError";
    }
}

/** A delivery that did not reach the agent. The send puts the batch back to `answered`. */
export class NotDeliveredError extends Error {
    constructor(readonly result: DeliveryResult) {
        super(`not delivered (${result.channel}): ${result.error ?? "no route"}`);
        this.name = "NotDeliveredError";
    }
}
