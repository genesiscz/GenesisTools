import type { DarwinKitOptions, MethodMap, MethodName, ReadyNotification } from "@genesiscz/darwinkit";
import { DarwinKit } from "@genesiscz/darwinkit";
import { logger } from "@genesiscz/utils/logger";
import { describeResponsibleIdentity } from "./genesis-app";

export type { DarwinKitOptions } from "@genesiscz/darwinkit";
export { DarwinKit, DarwinKitError } from "@genesiscz/darwinkit";

/**
 * True only when a macOS permission dialog can actually appear: the status is still
 * `notDetermined` (every other status resolves `authorized()` without ever showing UI
 * again) and the session is interactive (a non-TTY caller would never see it anyway).
 */
export function shouldAnnounceAccessPrompt(status: string, interactive: boolean): boolean {
    return status === "notDetermined" && interactive;
}

const DARWINKIT_ACCESS_NOT_AUTHORIZED_PATTERN =
    /^(Calendar|Reminders|Contacts) access not authorized\. Call (?:calendar|reminders|contacts)\.authorized first\.$/;

export type DarwinKitAccessService = "Calendar" | "Reminders" | "Contacts";

/**
 * Recognizes DarwinKit's internal readiness-gate message ("Call calendar.authorized
 * first.") so callers can translate it into something a user who just clicked Allow
 * can act on. Returns null for anything else, including a non-Error/non-string throw.
 */
export function parseDarwinKitAccessError(error: unknown): { service: DarwinKitAccessService } | null {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

    if (!message) {
        return null;
    }

    const match = DARWINKIT_ACCESS_NOT_AUTHORIZED_PATTERN.exec(message.trim());

    if (!match) {
        return null;
    }

    return { service: match[1] as DarwinKitAccessService };
}

/**
 * Maps DarwinKit's raw "<Service> access not authorized. Call <service>.authorized
 * first." (Calendar, Reminders, Contacts) to a message that names the responsible app
 * and the fix, instead of an internal API hint (#448, #449). Any other error passes
 * through unchanged.
 */
export function translateDarwinKitAccessError(error: unknown): Error {
    const parsed = parseDarwinKitAccessError(error);

    if (!parsed) {
        return error instanceof Error ? error : new Error(String(error));
    }

    const host = describeResponsibleIdentity();

    return new Error(
        `${parsed.service} access isn't granted yet for ${host}. If you just clicked Allow, run the command again. Otherwise: System Settings > Privacy & Security > ${parsed.service}, set ${host} on, then re-run.`
    );
}

/** How long the helper may take to start and send `ready`. */
const CONNECT_DEADLINE_MS = 30_000;
/** Added to a request's own timeout: a reply, or a reconnect after a helper crash, can land just after it. */
const REPLY_GRACE_MS = 15_000;
/** DarwinKit's own default request timeout, used when the caller passes none. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Keeps the process alive until `work` settles, and fails it after `ms`.
 *
 * DarwinKit unrefs its helper process and the helper's pipes, and its connect step waits for the
 * helper's `ready` line with no timer. A CLI that awaits only that line has nothing left to keep
 * Bun's event loop open, so Bun exits with code 0 in the middle of the await: no output, no error,
 * no `finally` (a held lock file stays behind). The timer here is the handle that was missing, and
 * its deadline turns a helper that never answers into an error the caller can print.
 */
export function holdUntilSettled<T>(
    work: Promise<T>,
    { ms, what, onExpire }: { ms: number; what: string; onExpire?: () => void }
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${what} after ${ms} ms`));
            try {
                onExpire?.();
            } catch (error) {
                logger.debug({ error, what }, "darwinkit deadline cleanup failed");
            }
        }, ms);

        work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

/**
 * The one DarwinKit client every GenesisTools caller builds, so no request waits on the helper
 * without a deadline and a handle that keeps the process alive.
 */
export class GuardedDarwinKit extends DarwinKit {
    private readonly requestTimeoutMs: number;
    private readonly connectDeadlineMs: number;
    private readonly replyGraceMs: number;

    constructor(options?: DarwinKitOptions, deadlines: { connectMs?: number; replyGraceMs?: number } = {}) {
        super(options);
        this.requestTimeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.connectDeadlineMs = deadlines.connectMs ?? CONNECT_DEADLINE_MS;
        this.replyGraceMs = deadlines.replyGraceMs ?? REPLY_GRACE_MS;
    }

    override connect(): Promise<ReadyNotification> {
        return holdUntilSettled(super.connect(), {
            ms: this.connectDeadlineMs,
            what: "The darwinkit helper sent no ready line",
            onExpire: () => {
                void this.close();
            },
        });
    }

    override async call<M extends MethodName>(
        method: M,
        params: MethodMap[M]["params"],
        options?: { timeout?: number }
    ): Promise<MethodMap[M]["result"]> {
        await this.connect();

        return holdUntilSettled(super.call(method, params, options), {
            ms: (options?.timeout ?? this.requestTimeoutMs) + this.replyGraceMs,
            what: `The darwinkit helper sent no answer to ${method}`,
            onExpire: () => {
                void this.close();
            },
        });
    }
}

let _instance: GuardedDarwinKit | null = null;

export function hasDarwinKit(): boolean {
    return _instance !== null;
}

export function getDarwinKit(options?: DarwinKitOptions): GuardedDarwinKit {
    if (_instance) {
        if (options && Object.keys(options).length > 0) {
            throw new Error("DarwinKit is already initialized. Call closeDarwinKit() before changing options.");
        }

        return _instance;
    }

    _instance = new GuardedDarwinKit({
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
