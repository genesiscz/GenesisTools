import { describe, expect, test } from "bun:test";
import { assertSafePathSegment } from "@app/agents/lib/paths";

/** ESC, built rather than typed, so this file stays plain text. */
const ESC = String.fromCharCode(27);

describe("assertSafePathSegment", () => {
    test("accepts the ids this system actually uses", () => {
        expect(assertSafePathSegment("c5922f36-0edf-4746-96b8-048940a43461", "session")).toBe(
            "c5922f36-0edf-4746-96b8-048940a43461"
        );
        expect(assertSafePathSegment("main_c5922f360edf", "agent id")).toBe("main_c5922f360edf");
        expect(assertSafePathSegment("agents-talk-smoke-019f1573", "session")).toBe("agents-talk-smoke-019f1573");
    });

    test("still rejects traversal and separators", () => {
        expect(() => assertSafePathSegment("..", "session")).toThrow();
        expect(() => assertSafePathSegment("a/b", "session")).toThrow();
        expect(() => assertSafePathSegment("", "session")).toThrow();
    });

    test("rejects captured terminal output, which created real unlistable directories", () => {
        // The shape that landed in ~/.genesis-tools/agents: an ANSI colour
        // code wrapped around a tick, plus the echoed test name.
        const ansi = `${ESC}[32m ok ${ESC}[0m discover lists lead`;
        expect(() => assertSafePathSegment(ansi, "session")).toThrow(/control character/);

        // Multi-line capture is the same mistake with a newline in it.
        expect(() => assertSafePathSegment("===\n  ok discover lists lead", "session")).toThrow(/control character/);
        expect(() => assertSafePathSegment("has\ttab", "session")).toThrow(/control character/);
    });

    test("rejects a whole command output pasted as an id, and stray whitespace", () => {
        expect(() => assertSafePathSegment("x".repeat(129), "session")).toThrow(/129 characters/);
        expect(assertSafePathSegment("x".repeat(128), "session")).toHaveLength(128);
        expect(() => assertSafePathSegment(" leading", "session")).toThrow(/whitespace/);
        expect(() => assertSafePathSegment("trailing ", "session")).toThrow(/whitespace/);
    });
});
