import { describe, expect, test } from "bun:test";
import { classifySelfSend } from "@app/cmux/lib/send-self-preflight";

const SURFACE = "03DA1B10-D019-4CF2-8014-5F0AFB7BAF88";

describe("classifySelfSend", () => {
    test("a tmux pane is a working transport on its own", () => {
        expect(classifySelfSend({ tmuxPane: "%7" }).ok).toBe(true);
    });

    test("a terminal surface the environment agrees on is fine", () => {
        expect(
            classifySelfSend({ envSurfaceId: SURFACE, callerSurfaceId: SURFACE, callerSurfaceType: "terminal" }).ok
        ).toBe(true);
    });

    test("a non-terminal surface cannot take keystrokes", () => {
        const verdict = classifySelfSend({
            envSurfaceId: SURFACE,
            callerSurfaceId: SURFACE,
            callerSurfaceType: "browser",
        });

        expect(verdict.ok).toBe(false);
        expect(verdict.detail).toContain("not a terminal");
    });

    test("an environment naming a different surface would type into the wrong place", () => {
        const verdict = classifySelfSend({
            envSurfaceId: "OLD-ID",
            callerSurfaceId: SURFACE,
            callerSurfaceType: "terminal",
        });

        expect(verdict.ok).toBe(false);
        expect(verdict.detail).toContain("cmux resolves");
    });

    test("outside both multiplexers there is nothing to send to", () => {
        const verdict = classifySelfSend({});

        expect(verdict.ok).toBe(false);
        expect(verdict.detail).toContain("not inside tmux or cmux");
    });
});
