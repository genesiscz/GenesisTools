import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    drainMark,
    envelopeActivity,
    firstOpenTurn,
    followTranscriptLive,
    LiveActivityTracker,
    LiveTurnStream,
} from "./live";
import type { ResolvedTranscript } from "./resolve";
import type { LiveActivity } from "./turn-state";
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

describe("drainMark", () => {
    it("a pending tool in a page's last turn holds the mark when the next page is drained", () => {
        const first = drainMark(null, 0, [turn("a", "x"), turn("b", "y", true)]);
        expect(first).toEqual({ open: 1, mark: 1 });

        const second = drainMark(first.open, 2, [turn("c", "z"), turn("d", "w")]);
        expect(second.mark).toBe(1);
    });

    it("settled pages move the mark to the last turn read", () => {
        const first = drainMark(null, 0, [turn("a", "x"), turn("b", "y")]);
        expect(drainMark(first.open, 2, [turn("c", "z")])).toEqual({ open: null, mark: 2 });
    });
});

describe("live activity", () => {
    it("LiveActivityTracker writes an activity line only when it changed", () => {
        const lines: string[] = [];
        const tracker = new LiveActivityTracker((line) => lines.push(line));
        const thinking: LiveActivity = {
            phase: "thinking",
            turnStartedAt: 1,
            since: 2,
            tool: null,
            openTools: 0,
            question: null,
            stalled: false,
            lastEventAt: 2,
        };

        expect(tracker.offer(thinking)).toBe(true);
        expect(tracker.offer({ ...thinking })).toBe(false);
        expect(tracker.offer(null)).toBe(false);
        expect(tracker.offer({ ...thinking, stalled: true })).toBe(true);
        expect(lines.map((line) => SafeJSON.parse(line, { strict: true }))).toEqual([
            { kind: "activity", ...thinking },
            { kind: "activity", ...thinking, stalled: true },
        ]);
    });

    it("envelopeActivity: a terminal event is idle, an open call in the last turn runs, else thinking", () => {
        const at = "2026-10-11T10:00:00.000Z";
        const open = { ...envelope([{ ...turn("a", "x", true), at }], 1) };
        const now = Date.parse(at) + 1000;

        expect(envelopeActivity(open, now, now)).toMatchObject({
            phase: "tool",
            tool: { name: "Bash", summary: "ls", startedAt: Date.parse(at) },
            openTools: 1,
        });
        expect(envelopeActivity(envelope([turn("a", "x")], 1), now, now).phase).toBe("thinking");
        expect(envelopeActivity({ ...open, terminated: "end" }, now, now).phase).toBe("idle");
        expect(envelopeActivity(open, now, now + 11 * 60_000).stalled).toBe(true);
    });

    it("followTranscriptLive sends the activity after the turn lines, and again when the tool's result lands", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-live-activity-"));
        const file = join(dir, "s.jsonl");
        const record = (value: Record<string, unknown>): string => `${SafeJSON.stringify(value)}\n`;
        const at = (sec: number): string => new Date(Date.now() - 60_000 + sec * 1000).toISOString();
        writeFileSync(
            file,
            record({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }) +
                record({
                    type: "assistant",
                    timestamp: at(1),
                    message: {
                        id: "m1",
                        role: "assistant",
                        stop_reason: "tool_use",
                        content: [
                            {
                                type: "tool_use",
                                id: "t1",
                                name: "Bash",
                                input: { command: "make", description: "Build" },
                            },
                        ],
                    },
                })
        );
        const resolved: ResolvedTranscript = { provider: "claude", source: "native", sessionId: "s", filePath: file };
        const lines: Record<string, unknown>[] = [];
        const ac = new AbortController();
        const until = async (done: () => boolean): Promise<void> => {
            const started = Date.now();
            while (!done() && Date.now() - started < 3000) {
                await Bun.sleep(20);
            }
        };
        const activities = () => lines.filter((line) => line.kind === "activity");
        const follow = followTranscriptLive(resolved, {
            offset: 0,
            signal: ac.signal,
            write: (line) => lines.push(SafeJSON.parse(line, { strict: true })),
        });

        try {
            await until(() => activities().length > 0);
            expect(lines.map((line) => line.kind ?? "turn")).toEqual(["turn", "turn", "totals", "activity"]);
            expect(activities()[0]).toMatchObject({ phase: "tool", tool: { name: "Bash", summary: "Build" } });

            appendFileSync(
                file,
                record({
                    type: "user",
                    timestamp: at(5),
                    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
                })
            );
            await until(() => activities().length > 1);
            expect(activities()[1]).toMatchObject({ phase: "thinking", tool: null });
        } finally {
            ac.abort();
            await follow;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
