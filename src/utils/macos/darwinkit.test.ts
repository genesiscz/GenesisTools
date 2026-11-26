import { describe, expect, spyOn, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    createIdleCloser,
    GuardedDarwinKit,
    holdUntilSettled,
    parseDarwinKitAccessError,
    shouldAnnounceAccessPrompt,
    translateDarwinKitAccessError,
} from "./darwinkit";
import { fakeDarwinKitPath, silentDarwinKitPath } from "./testing/fake-darwinkit";

/**
 * `MacReminders.requestAccess` retires the DarwinKit helper it spawned, because
 * EventKit caches the authorization a process saw at launch. The client is
 * process-wide and closing it rejects its pending requests, so that close used to
 * fail a concurrent list or write with `Client closed` (CodeRabbit review, PR
 * #363). These pin the rule that defers it; the real close is injected so no test
 * spawns the Swift helper.
 */
describe("createIdleCloser", () => {
    function spy(): { closes: number; close: () => void } {
        const state = { closes: 0, close: () => {} };
        state.close = () => {
            state.closes += 1;
        };

        return state;
    }

    test("closes immediately when nothing holds a lease", () => {
        const close = spy();
        createIdleCloser(close.close).closeWhenIdle();

        expect(close.closes).toBe(1);
    });

    test("waits for an in-flight operation, then closes once", () => {
        const close = spy();
        const closer = createIdleCloser(close.close);
        const release = closer.lease();

        closer.closeWhenIdle();
        expect(close.closes).toBe(0);

        release();
        expect(close.closes).toBe(1);
    });

    test("waits for the LAST of several operations", () => {
        const close = spy();
        const closer = createIdleCloser(close.close);
        const first = closer.lease();
        const second = closer.lease();

        closer.closeWhenIdle();
        first();
        expect(close.closes).toBe(0);

        second();
        expect(close.closes).toBe(1);
    });

    test("negative control: a lease that nobody asked to close leaves the client alone", () => {
        const close = spy();
        const closer = createIdleCloser(close.close);

        closer.lease()();
        expect(close.closes).toBe(0);
    });

    test("releasing twice does not close twice", () => {
        const close = spy();
        const closer = createIdleCloser(close.close);
        const release = closer.lease();

        closer.closeWhenIdle();
        release();
        release();

        expect(close.closes).toBe(1);
    });

    test("cancel drops a deferred close, so an immediate one is not repeated", () => {
        const close = spy();
        const closer = createIdleCloser(close.close);
        const release = closer.lease();

        closer.closeWhenIdle();
        closer.cancel();
        release();

        expect(close.closes).toBe(0);
    });

    test("a lease taken after the deferred close still gets its own close", () => {
        const close = spy();
        const closer = createIdleCloser(close.close);
        const first = closer.lease();

        closer.closeWhenIdle();
        first();
        expect(close.closes).toBe(1);

        const second = closer.lease();
        closer.closeWhenIdle();
        second();

        expect(close.closes).toBe(2);
    });
});

/**
 * Regression test: #448 / #449 — a macOS permission dialog can only appear once per
 * authorization decision. Printing "watch for a system dialog" for any other status
 * would promise a dialog that never shows (denied/restricted/writeOnly/fullAccess all
 * resolve `authorized()` without ever displaying UI again).
 */
describe("shouldAnnounceAccessPrompt", () => {
    test("announces only for notDetermined in an interactive session", () => {
        expect(shouldAnnounceAccessPrompt("notDetermined", true)).toBe(true);
    });

    test("stays silent for notDetermined when not interactive", () => {
        expect(shouldAnnounceAccessPrompt("notDetermined", false)).toBe(false);
    });

    test.each(["denied", "restricted", "writeOnly", "fullAccess"] as const)(
        "stays silent for %s even when interactive, since no dialog will show",
        (status) => {
            expect(shouldAnnounceAccessPrompt(status, true)).toBe(false);
        }
    );
});

/**
 * Regression test: #448 / #449 — DarwinKit's raw "Calendar access not authorized. Call
 * calendar.authorized first." (and the Reminders/Contacts variants) is an internal API
 * hint, meaningless to a user who just clicked Allow (#448 step 4).
 */
describe("parseDarwinKitAccessError", () => {
    test.each([
        ["Calendar access not authorized. Call calendar.authorized first.", "Calendar"],
        ["Reminders access not authorized. Call reminders.authorized first.", "Reminders"],
        ["Contacts access not authorized. Call contacts.authorized first.", "Contacts"],
    ] as const)("recognizes the %s raw DarwinKit message", (message, service) => {
        expect(parseDarwinKitAccessError(new Error(message))).toEqual({ service });
    });

    test("returns null for an unrelated error", () => {
        expect(parseDarwinKitAccessError(new Error("ECONNRESET"))).toBeNull();
    });

    test("returns null for a non-error, non-string value", () => {
        expect(parseDarwinKitAccessError({ weird: true })).toBeNull();
    });
});

describe("translateDarwinKitAccessError", () => {
    test("turns the raw Calendar message into a friendly one that names the fix", () => {
        const translated = translateDarwinKitAccessError(
            new Error("Calendar access not authorized. Call calendar.authorized first.")
        );

        expect(translated.message).toContain("Calendar");
        expect(translated.message).toContain("System Settings");
        expect(translated.message).not.toContain("calendar.authorized first");
    });

    test("turns the raw Reminders message into a friendly one that names the fix", () => {
        const translated = translateDarwinKitAccessError(
            new Error("Reminders access not authorized. Call reminders.authorized first.")
        );

        expect(translated.message).toContain("Reminders");
        expect(translated.message).not.toContain("reminders.authorized first");
    });

    test("passes an unrelated error through unchanged", () => {
        const original = new Error("ECONNRESET");

        expect(translateDarwinKitAccessError(original)).toBe(original);
    });

    test("wraps a non-Error throw into a real Error", () => {
        const translated = translateDarwinKitAccessError("boom");

        expect(translated).toBeInstanceOf(Error);
        expect(translated.message).toBe("boom");
    });
});

/**
 * DarwinKit unrefs its helper and the helper's pipes, and waits for the helper's `ready` line with
 * no timer. A CLI that awaits only that line had nothing holding Bun's event loop open, so Bun
 * exited with code 0 in the middle of the await: `tools todo add --sync-to calendar` printed
 * nothing, recorded no sync and left its lock file behind (2026-11-24).
 */
describe("holdUntilSettled", () => {
    test("passes the value through", async () => {
        expect(await holdUntilSettled(Promise.resolve(7), { ms: 1_000, what: "work" })).toBe(7);
    });

    test("passes a rejection through unchanged", async () => {
        const failure = new Error("helper said no");

        await expect(holdUntilSettled(Promise.reject(failure), { ms: 1_000, what: "work" })).rejects.toBe(failure);
    });

    test("rejects with its label after the deadline and runs onExpire once", async () => {
        let expired = 0;
        const pending = holdUntilSettled(new Promise<never>(() => {}), {
            ms: 20,
            what: "The helper sent no answer to x",
            onExpire: () => {
                expired += 1;
            },
        });

        await expect(pending).rejects.toThrow("The helper sent no answer to x after 20 ms");
        expect(expired).toBe(1);
    });

    test("expiry rejects with the deadline even when cleanup throws", async () => {
        const pending = holdUntilSettled(new Promise<never>(() => {}), {
            ms: 20,
            what: "stalled helper",
            onExpire: () => {
                throw new Error("cleanup failed");
            },
        });
        await expect(pending).rejects.toThrow("stalled helper after 20 ms");
    });

    test("negative control: a settled wait never runs onExpire", async () => {
        let expired = 0;
        await holdUntilSettled(Promise.resolve(), {
            ms: 20,
            what: "work",
            onExpire: () => {
                expired += 1;
            },
        });
        await Bun.sleep(40);

        expect(expired).toBe(0);
    });
});

describe("GuardedDarwinKit", () => {
    test("closes a silent helper and rejects connect at the deadline", async () => {
        const dk = new GuardedDarwinKit(
            { binary: silentDarwinKitPath(), reconnect: { enabled: false } },
            { connectMs: 40 }
        );
        const close = spyOn(dk, "close");
        try {
            await expect(dk.connect()).rejects.toThrow("The darwinkit helper sent no ready line after 40 ms");
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            close.mockRestore();
            await dk.close();
        }
    });

    test("a standalone CLI stays alive until a silent helper fails its deadline", async () => {
        const source = `import { GuardedDarwinKit } from ${SafeJSON.stringify(import.meta.resolve("./darwinkit"))};
const dk = new GuardedDarwinKit(
    { binary: ${SafeJSON.stringify(silentDarwinKitPath())}, reconnect: { enabled: false } },
    { connectMs: 40 }
);
try {
    await dk.connect();
    process.exitCode = 1;
} catch (error) {
    process.stdout.write(String(error));
    process.exitCode = 7;
} finally {
    await dk.close();
}`;
        const child = Bun.spawn([process.execPath, "--eval", source], {
            cwd: process.cwd(),
            env: env.getProcessEnv(),
            stdout: "pipe",
            stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill(), 5_000);
        try {
            const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
            expect(code).toBe(7);
            expect(output).toContain("The darwinkit helper sent no ready line after 40 ms");
        } finally {
            clearTimeout(timeout);
            child.kill();
        }
    });

    test("answers through a helper that sends ready, and passes its status through", async () => {
        const dk = new GuardedDarwinKit({ binary: fakeDarwinKitPath(), timeout: 5_000, reconnect: { enabled: false } });

        try {
            const answer = await dk.calendar.authorized();

            expect(answer.status).toBe("notDetermined");
        } finally {
            await dk.close();
        }
    });
});
