import type { DarwinKitOptions } from "@genesiscz/darwinkit";
import { DarwinKit } from "@genesiscz/darwinkit";
import { logger } from "@genesiscz/utils/logger";

export type { DarwinKitOptions } from "@genesiscz/darwinkit";
export { DarwinKit, DarwinKitError } from "@genesiscz/darwinkit";

let _instance: DarwinKit | null = null;

export function hasDarwinKit(): boolean {
    return _instance !== null;
}

export function getDarwinKit(options?: DarwinKitOptions): DarwinKit {
    if (_instance) {
        if (options && Object.keys(options).length > 0) {
            throw new Error("DarwinKit is already initialized. Call closeDarwinKit() before changing options.");
        }

        return _instance;
    }

    _instance = new DarwinKit({
        timeout: 60_000,
        logger,
        logLevel: "warn",
        ...options,
    });

    return _instance;
}

export function closeDarwinKit(): void {
    idleCloser.cancel();

    if (_instance) {
        _instance.close();
        _instance = null;
    }
}

/**
 * Close a shared resource once nothing is using it.
 *
 * `close` is injected so the rule can be tested without spawning the real helper.
 * The counter is deliberately not a queue: callers are not serialised, they only
 * keep the client alive for the length of their own request.
 */
export interface IdleCloser {
    /** Hold the resource for one operation. Call the returned function when it settles. */
    lease(): () => void;
    /** Close now if nothing holds a lease, otherwise as soon as the last one is released. */
    closeWhenIdle(): void;
    /** Forget a deferred close. An immediate close has already satisfied it. */
    cancel(): void;
}

export function createIdleCloser(close: () => void): IdleCloser {
    let leases = 0;
    let pending = false;

    return {
        lease() {
            leases += 1;
            let released = false;

            return () => {
                if (released) {
                    return;
                }

                released = true;
                leases -= 1;

                if (leases === 0 && pending) {
                    pending = false;
                    close();
                }
            };
        },

        closeWhenIdle() {
            if (leases === 0) {
                close();
                return;
            }

            pending = true;
        },

        cancel() {
            pending = false;
        },
    };
}

const idleCloser = createIdleCloser(() => closeDarwinKit());

/**
 * Hold the shared client for one operation, so a caller that wants to retire it
 * cannot cut off a request another caller still has in flight.
 */
export function leaseDarwinKit(): () => void {
    return idleCloser.lease();
}

/**
 * Retire the shared client once every leased operation has finished.
 *
 * `closeDarwinKit` rejects the client's pending requests, and the client is
 * process-wide: a permission request that closed the helper it had spawned failed
 * a concurrent reminders list with `Client closed` or `Disconnected`. The retire
 * still happens, just after the operations that were already running.
 */
export function closeDarwinKitWhenIdle(): void {
    idleCloser.closeWhenIdle();
}
