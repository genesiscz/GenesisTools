import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { firstOpenTurn, LiveTurnStream } from "./live";
import type { TranscriptEnvelope, TranscriptTurn } from "./types";

function turn(id: string, text: string, pending = false): TranscriptTurn {
    return {
        id,
        role: "assistant",
        at: null,
        text,
        tools: pending ? [{ id: `${id}-t`, name: "Bash", inputPreview: "ls", result: null, isError: false }] : [],
    };
}

function envelope(turns: TranscriptTurn[], nextOffset: number): TranscriptEnvelope {
    return {
        provider: "claude",
        sessionId: "s",
        filePath: "/x.jsonl",
        byteSize: 1,
        truncated: true,
        nextOffset,
        turns,
        totals: { modelCalls: nextOffset },
        terminated: null,
        turnCount: nextOffset,
    };
}

function capture(offset: number): { stream: LiveTurnStream; lines: Record<string, unknown>[] } {
    const lines: Record<string, unknown>[] = [];
    const stream = new LiveTurnStream(offset, (line) => lines.push(SafeJSON.parse(line, { strict: true })));
    return { stream, lines };
}

describe("LiveTurnStream", () => {
    it("sends each turn with its index, then a totals line", () => {
        const { stream, lines } = capture(10);
        stream.envelope(envelope([turn("a", "one"), turn("b", "two")], 12));
        expect(lines.map((line) => line.index ?? line.kind)).toEqual([10, 11, "totals"]);
        expect(lines[2]).toMatchObject({ kind: "totals", nextOffset: 12, turnCount: 12, terminated: null });
    });

    it("sends nothing when nothing changed, and a growing turn again under the same index", () => {
        const { stream, lines } = capture(10);
        stream.envelope(envelope([turn("a", "one"), turn("b", "tw")], 12));
        lines.length = 0;
        stream.envelope(envelope([turn("b", "tw")], 12));
        expect(lines).toEqual([]);

        stream.envelope(envelope([turn("b", "two"), turn("c", "three")], 13));
        expect(lines.map((line) => line.index ?? line.kind)).toEqual([11, 12, "totals"]);
        expect(lines[0]).toMatchObject({ id: "b", text: "two" });
    });

    it("moves the re-read window to the oldest turn that can still change", () => {
        const { stream } = capture(10);
        stream.envelope(
            envelope([turn("a", "one"), turn("b", "two", true), turn("c", "three"), turn("d", "four")], 14)
        );
        // b waits for its tool result, so it and everything after it are read again.
        expect(stream.offset).toBe(11);

        stream.envelope(envelope([turn("b", "two"), turn("c", "three"), turn("d", "four")], 14));
        // Only the last turn can still grow.
        expect(stream.offset).toBe(13);
    });

    it("a drained page past the window sends its turns but keeps the re-read window on the open tool", () => {
        const { stream, lines } = capture(10);
        stream.envelope(envelope([turn("a", "one"), turn("b", "two", true)], 12));
        expect(stream.offset).toBe(11);

        stream.envelope(envelope([turn("c", "three"), turn("d", "four")], 14), { advance: false });
        expect(lines.filter((line) => line.index !== undefined).map((line) => line.index)).toEqual([10, 11, 12, 13]);
        expect(stream.offset).toBe(11);
    });

    it("sends a totals line alone when only the end state changed", () => {
        const { stream, lines } = capture(0);
        stream.envelope(envelope([turn("a", "one")], 1));
        lines.length = 0;
        stream.envelope({ ...envelope([turn("a", "one")], 1), terminated: "end" });
        expect(lines).toEqual([expect.objectContaining({ kind: "totals", terminated: "end" })]);
    });
});

describe("firstOpenTurn", () => {
    it("is the first turn with a tool still waiting, else the last turn", () => {
        expect(firstOpenTurn(10, [turn("a", "x"), turn("b", "y", true), turn("c", "z")])).toBe(11);
        expect(firstOpenTurn(10, [turn("a", "x"), turn("b", "y")])).toBe(11);
    });
});
