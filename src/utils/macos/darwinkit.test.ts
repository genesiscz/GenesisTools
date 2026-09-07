import { describe, expect, test } from "bun:test";
import { createIdleCloser } from "./darwinkit";

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
