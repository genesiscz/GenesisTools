import { describe, expect, test } from "bun:test";
import {
    createIdleCloser,
    parseDarwinKitAccessError,
    shouldAnnounceAccessPrompt,
    translateDarwinKitAccessError,
} from "./darwinkit";

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
