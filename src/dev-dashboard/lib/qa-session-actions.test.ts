import { describe, expect, test } from "bun:test";
import { hasRealSessionId, resumeCommandFor, sessionActionStates, sessionActionsNotice } from "./qa-session-actions";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("hasRealSessionId", () => {
    test('rejects the "unknown" placeholder and blank ids', () => {
        expect(hasRealSessionId(SESSION)).toBe(true);
        expect(hasRealSessionId("unknown")).toBe(false);
        expect(hasRealSessionId("   ")).toBe(false);
        expect(hasRealSessionId(null)).toBe(false);
    });
});

describe("sessionActionStates", () => {
    test("every verb is usable for a real session with a live cmux", () => {
        const states = sessionActionStates({ sessionId: SESSION, cmuxPaneCount: 3 });

        expect(states.focus.enabled).toBe(true);
        expect(states.cmux.enabled).toBe(true);
        expect(states.copyId.enabled).toBe(true);
        expect(states.copyResume.enabled).toBe(true);
        expect(sessionActionsNotice(states)).toBeNull();
    });

    test("an unknown session id disables all four with one reason", () => {
        const states = sessionActionStates({ sessionId: "unknown", cmuxPaneCount: 3 });

        expect(Object.values(states).every((s) => !s.enabled)).toBe(true);
        expect(sessionActionsNotice(states)).toContain("no session id");
    });

    test("a dead cmux disables focus and the picker but keeps both copies", () => {
        const states = sessionActionStates({ sessionId: SESSION, cmuxUnavailable: true });

        expect(states.focus.enabled).toBe(false);
        expect(states.cmux.enabled).toBe(false);
        expect(states.copyId.enabled).toBe(true);
        expect(states.copyResume.enabled).toBe(true);
        expect(sessionActionsNotice(states)).toContain("cmux is not reachable");
    });

    test("cmux running with zero panes says so rather than claiming it is down", () => {
        const states = sessionActionStates({ sessionId: SESSION, cmuxPaneCount: 0 });

        expect(states.focus.enabled).toBe(false);
        expect(states.focus.reason).toContain("no open pane");
    });

    test("a still-loading snapshot leaves the verbs usable", () => {
        const states = sessionActionStates({ sessionId: SESSION });

        expect(states.focus.enabled).toBe(true);
    });
});

describe("resumeCommandFor", () => {
    test("is the string Copy resume writes to the clipboard", () => {
        expect(resumeCommandFor(SESSION)).toBe(`tools claude run --resume ${SESSION}`);
    });
});
