import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { DarwinKit } from "@genesiscz/darwinkit";
import {
    DarwinkitCrashError,
    DarwinkitTimeoutError,
    type RemindersAuthClient,
    type RemindersAuthResult,
    remindersPermissionMessage,
    resolveRemindersAuthorization,
    runDarwinkitGuarded,
} from "../apple-reminders";

interface FakeRemindersAuth extends RemindersAuthClient {
    requests: number;
    statusChecks: number;
}

function fakeRemindersAuth(
    initial: RemindersAuthResult,
    afterRequest: RemindersAuthResult = initial
): FakeRemindersAuth {
    const auth: FakeRemindersAuth = {
        requests: 0,
        statusChecks: 0,
        authorizationStatus: async () => {
            auth.statusChecks++;
            return initial;
        },
        requestAccess: async () => {
            auth.requests++;
            return afterRequest;
        },
    };
    return auth;
}

type EventName =
    | "ready"
    | "filesChanged"
    | "llmChunk"
    | "notificationInteraction"
    | "reconnect"
    | "disconnect"
    | "error";

interface FakeChild {
    pid: number;
    stderr: EventEmitter;
}

class FakeDarwinKit {
    readonly emitter = new EventEmitter();
    readonly transport: { process: FakeChild | null };
    connectCalls = 0;

    constructor(child: FakeChild | null = { pid: 99999, stderr: new EventEmitter() }) {
        this.transport = { process: child };
    }

    async connect(): Promise<{ version: string; capabilities: string[] }> {
        this.connectCalls++;
        return { version: "test", capabilities: [] };
    }

    on<E extends EventName>(event: E, handler: (payload: unknown) => void): () => void {
        this.emitter.on(event, handler);
        return () => this.emitter.off(event, handler);
    }

    emitDisconnect(code: number | null): void {
        this.emitter.emit("disconnect", { code });
    }

    emitError(error: Error): void {
        this.emitter.emit("error", { error });
    }

    pushStderr(line: string): void {
        this.transport.process?.stderr.emit("data", `${line}\n`);
    }
}

function asClient(fake: FakeDarwinKit): DarwinKit {
    return fake as unknown as DarwinKit;
}

describe("runDarwinkitGuarded", () => {
    it("rejects with DarwinkitTimeoutError when fn never resolves", async () => {
        const fake = new FakeDarwinKit();

        const start = Date.now();
        let rejected: unknown = null;

        try {
            await runDarwinkitGuarded(
                asClient(fake),
                "test.hang",
                () =>
                    new Promise<string>(() => {
                        // never resolves
                    }),
                { timeoutMs: 60 }
            );
        } catch (err) {
            rejected = err;
        }

        const elapsed = Date.now() - start;
        expect(rejected).toBeInstanceOf(DarwinkitTimeoutError);
        const err = rejected as DarwinkitTimeoutError;
        expect(err.operation).toBe("test.hang");
        expect(err.timeoutMs).toBe(60);
        expect(elapsed).toBeLessThan(500);
    });

    it("rejects with DarwinkitCrashError when child disconnects mid-request", async () => {
        const fake = new FakeDarwinKit();
        let rejected: unknown = null;

        const promise = runDarwinkitGuarded(
            asClient(fake),
            "test.crash",
            () =>
                new Promise<string>(() => {
                    // never resolves on its own
                }),
            { timeoutMs: 5_000 }
        );

        setTimeout(() => fake.emitDisconnect(6), 10);

        try {
            await promise;
        } catch (err) {
            rejected = err;
        }

        expect(rejected).toBeInstanceOf(DarwinkitCrashError);
        const err = rejected as DarwinkitCrashError;
        expect(err.operation).toBe("test.crash");
        expect(err.exitCode).toBe(6);
    });

    it("rejects with DarwinkitCrashError when transport emits 'error'", async () => {
        const fake = new FakeDarwinKit();
        let rejected: unknown = null;

        const promise = runDarwinkitGuarded(
            asClient(fake),
            "test.error",
            () =>
                new Promise<string>(() => {
                    // never resolves
                }),
            { timeoutMs: 5_000 }
        );

        setTimeout(() => fake.emitError(new Error("EPIPE")), 10);

        try {
            await promise;
        } catch (err) {
            rejected = err;
        }

        expect(rejected).toBeInstanceOf(DarwinkitCrashError);
    });

    it("resolves when fn resolves before timeout", async () => {
        const fake = new FakeDarwinKit();

        const result = await runDarwinkitGuarded(asClient(fake), "test.ok", async () => "value", { timeoutMs: 1_000 });

        expect(result).toBe("value");
    });

    it("captures stderr tail in timeout error when child stderr is reachable", async () => {
        const fake = new FakeDarwinKit();
        let rejected: unknown = null;

        try {
            await runDarwinkitGuarded(
                asClient(fake),
                "test.hangstderr",
                async () => {
                    // stderr listener wires up on first guarded call; emit AFTER the
                    // wrapper has had a chance to attach (next microtask).
                    await Promise.resolve();
                    fake.pushStderr("warning: boom");
                    fake.pushStderr("fatal: kvc raise");
                    return new Promise<string>(() => {
                        // never resolves
                    });
                },
                { timeoutMs: 80 }
            );
        } catch (err) {
            rejected = err;
        }

        expect(rejected).toBeInstanceOf(DarwinkitTimeoutError);
        const err = rejected as DarwinkitTimeoutError;
        expect(err.diagnostics.stderrTail ?? "").toContain("fatal: kvc raise");
    });

    it("rewraps 'Transport already started' as a crash so the shared client is dropped and respawned", async () => {
        const fake = new FakeDarwinKit();
        let rejected: unknown = null;

        try {
            await runDarwinkitGuarded(
                asClient(fake),
                "test.stale-transport",
                async () => {
                    throw new Error("Transport already started");
                },
                { timeoutMs: 1_000 }
            );
        } catch (err) {
            rejected = err;
        }

        expect(rejected).toBeInstanceOf(DarwinkitCrashError);
        expect((rejected as Error).cause).toBeInstanceOf(Error);
    });

    it("does not leak listeners across sequential calls", async () => {
        const fake = new FakeDarwinKit();

        for (let i = 0; i < 5; i++) {
            await runDarwinkitGuarded(asClient(fake), "test.seq", async () => i, { timeoutMs: 1_000 });
        }

        // disconnect/error listeners should be torn down after each call
        expect(fake.emitter.listenerCount("disconnect")).toBe(0);
        expect(fake.emitter.listenerCount("error")).toBe(0);
    });

    it("does not interleave: a second call gets its own crash signal after the first settled", async () => {
        const fake = new FakeDarwinKit();
        let firstRejected = false;

        const first = runDarwinkitGuarded(
            asClient(fake),
            "test.serial.1",
            () =>
                new Promise<string>(() => {
                    // never resolves
                }),
            { timeoutMs: 5_000 }
        ).catch(() => {
            firstRejected = true;
        });

        setTimeout(() => fake.emitDisconnect(6), 5);
        await first;
        expect(firstRejected).toBe(true);

        // After the first call settled and listeners are torn down, the SAME fake
        // instance can be used again. Emitting disconnect now should NOT affect
        // any previous in-flight promise (it's already settled). Then a second
        // call should still complete normally on its own promise.
        fake.emitDisconnect(6); // no-op: no listeners

        const result = await runDarwinkitGuarded(asClient(fake), "test.serial.2", async () => "second", {
            timeoutMs: 1_000,
        });

        expect(result).toBe("second");
    });

    // Regression test: #448 / #449 — the shared layer must translate DarwinKit's internal
    // "Call reminders.authorized first." into a friendly message for every reminders call,
    // not just the ones an individual caller remembered to guard.
    it("translates a raw DarwinKit access-not-authorized rejection into a friendly error", async () => {
        const fake = new FakeDarwinKit();
        let rejected: unknown = null;

        try {
            await runDarwinkitGuarded(
                asClient(fake),
                "test.access",
                async () => {
                    throw new Error("Reminders access not authorized. Call reminders.authorized first.");
                },
                { timeoutMs: 1_000 }
            );
        } catch (err) {
            rejected = err;
        }

        expect(rejected).toBeInstanceOf(Error);
        const err = rejected as Error;
        expect(err.message).not.toContain("reminders.authorized first");
        expect(err.message).toContain("Reminders");
    });
});

// Regression test: #449 — `list-lists` and `list` never called anything that requests
// Reminders access, so on a fresh Mac macOS never showed the permission dialog at all.
describe("resolveRemindersAuthorization", () => {
    it("returns the status without requesting when already authorized", async () => {
        const auth = fakeRemindersAuth({ status: "fullAccess", authorized: true });
        const result = await resolveRemindersAuthorization(auth);
        expect(result.authorized).toBe(true);
        expect(auth.requests).toBe(0);
    });

    it("requests access when not authorized and requestIfNeeded is not disabled", async () => {
        const auth = fakeRemindersAuth(
            { status: "notDetermined", authorized: false },
            { status: "fullAccess", authorized: true }
        );
        const result = await resolveRemindersAuthorization(auth);
        expect(result.authorized).toBe(true);
        expect(auth.requests).toBe(1);
    });

    it("never requests when requestIfNeeded is false, e.g. a non-interactive caller", async () => {
        const auth = fakeRemindersAuth({ status: "notDetermined", authorized: false });
        const result = await resolveRemindersAuthorization(auth, { requestIfNeeded: false });
        expect(result.authorized).toBe(false);
        expect(auth.requests).toBe(0);
    });

    it("checks the current status before deciding whether to request", async () => {
        const auth = fakeRemindersAuth({ status: "fullAccess", authorized: true });
        await resolveRemindersAuthorization(auth);
        expect(auth.statusChecks).toBeGreaterThan(0);
    });
});

describe("remindersPermissionMessage", () => {
    it("names the fix and tells the user to re-run after Allow, not the non-prompting command", () => {
        const message = remindersPermissionMessage("denied");
        expect(message).toContain("denied");
        expect(message).toContain("Privacy & Security");
        expect(message).toContain("Reminders");
        expect(message).toContain("run the command again");
        expect(message).not.toContain("list-lists");
        expect(message).not.toContain("dashboard");
    });

    it("includes the status for every status value", () => {
        expect(remindersPermissionMessage("restricted")).toContain("restricted");
        expect(remindersPermissionMessage("notDetermined")).toContain("notDetermined");
    });
});
