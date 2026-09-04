import { describe, expect, test } from "bun:test";
import { coalesceWorkerEvents, formatWorkerEvent, type WorkerEvent } from "./events";

const S = "00000000-0000-4000-8000-000000000001";

function text(t: string, delta: boolean): WorkerEvent {
    return { kind: "text", sessionId: S, text: t, delta };
}

function reasoning(t: string, delta: boolean): WorkerEvent {
    return { kind: "reasoning", sessionId: S, text: t, delta };
}

describe("coalesceWorkerEvents", () => {
    test("a run of grok-style deltas becomes one whole message (regression: one line per token)", () => {
        const events = [
            reasoning("The", true),
            reasoning(" user", true),
            reasoning(" wants", true),
            text("I'll", true),
            text(" read", true),
            text(" the spec.", true),
            { kind: "tool_call", sessionId: S, tool: "read_file", target: "Spec.md" },
            text("Done", true),
            text(".", true),
        ] satisfies WorkerEvent[];

        const folded = coalesceWorkerEvents(events);

        expect(folded).toEqual([
            reasoning("The user wants", false),
            text("I'll read the spec.", false),
            { kind: "tool_call", sessionId: S, tool: "read_file", target: "Spec.md" },
            text("Done.", false),
        ]);
        expect(folded.map(formatWorkerEvent)).toEqual([
            "🧠 The user wants",
            "💬 I'll read the spec.",
            "🔧 read_file Spec.md",
            "💬 Done.",
        ]);
    });

    test("codex-style deltas followed by the completed message print once", () => {
        const events = [text("Hel", true), text("lo", true), text("Hello", false)];

        expect(coalesceWorkerEvents(events)).toEqual([text("Hello", false)]);
    });

    test("a completed message of another kind does not swallow the run", () => {
        const events = [reasoning("think", true), text("answer", false)];

        expect(coalesceWorkerEvents(events)).toEqual([reasoning("think", false), text("answer", false)]);
    });

    test("non-delta events and an empty input pass through unchanged", () => {
        const events = [
            { kind: "turn.started", sessionId: S, turn: 1 },
            text("whole", false),
            { kind: "turn.completed", sessionId: S, turn: 1 },
        ] satisfies WorkerEvent[];

        expect(coalesceWorkerEvents(events)).toEqual(events);
        expect(coalesceWorkerEvents([])).toEqual([]);
    });

    test("a trailing run with no terminator is still flushed (a turn that died mid-sentence)", () => {
        expect(coalesceWorkerEvents([text("partial", true), text(" answer", true)])).toEqual([
            text("partial answer", false),
        ]);
    });
});
