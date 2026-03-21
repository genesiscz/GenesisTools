import { describe, expect, it } from "bun:test";
import { Indexer } from "./indexer";

/**
 * Test the cancellation API on the Indexer class.
 * We access the public requestCancellation() / isCancelled getter
 * by creating a minimal prototype-only instance (constructor is private).
 */

interface Cancellable {
    requestCancellation(): void;
    readonly isCancelled: boolean;
}

/** Build a lightweight object with just the cancellation surface */
function makeCancellable(): Cancellable {
    // Indexer stores the flag as `cancellationRequested` (private), but
    // exposes it through the public `requestCancellation` / `isCancelled` API.
    // We exercise that through a plain prototype instance.
    const obj = Object.create(Indexer.prototype) as Cancellable & Record<string, unknown>;

    // The private field defaults to false via the class field initializer.
    // Object.create does NOT run the constructor, so set the backing field manually.
    obj.cancellationRequested = false;

    return obj;
}

describe("Indexer cancellation", () => {
    it("isCancelled is false initially", () => {
        const c = makeCancellable();
        expect(c.isCancelled).toBe(false);
    });

    it("requestCancellation sets isCancelled to true", () => {
        const c = makeCancellable();
        c.requestCancellation();
        expect(c.isCancelled).toBe(true);
    });

    it("calling requestCancellation multiple times is idempotent", () => {
        const c = makeCancellable();
        c.requestCancellation();
        c.requestCancellation();
        expect(c.isCancelled).toBe(true);
    });
});
