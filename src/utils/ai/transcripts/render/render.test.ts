import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { grokWorkerTextToTurns } from "../grok";
import { type TranscriptEnvelope, type TranscriptTurn, terminatedOf, totalsOf } from "../types";
import { defaultRenderContext, type RenderContext, rendererFor, TRANSCRIPT_FORMATS } from "./index";

const fixturePath = join(import.meta.dir, "..", "fixtures", "grok-worker-turn.jsonl");
const fixture = readFileSync(fixturePath, "utf8");

function envelopeOf(turns: TranscriptTurn[], overrides: Partial<TranscriptEnvelope> = {}): TranscriptEnvelope {
    return {
        provider: "grok",
        sessionId: "sess",
        filePath: fixturePath,
        byteSize: fixture.length,
        truncated: false,
        nextOffset: turns.length,
        turns,
        totals: totalsOf(turns),
        terminated: terminatedOf(turns),
        ...overrides,
    };
}

function capture(overrides: Partial<RenderContext> = {}) {
    const lines: string[] = [];
    const status: string[] = [];
    const results: unknown[] = [];
    const ctx = defaultRenderContext({
        write: (line) => lines.push(line),
        status: (line) => status.push(line),
        result: (value) => results.push(value),
        ...overrides,
    });
    return { ctx, lines, status, results };
}

const turns = grokWorkerTextToTurns(fixture, "sess");

describe("rendererFor", () => {
    test("every declared format has a renderer that reports its own name", () => {
        for (const format of TRANSCRIPT_FORMATS) {
            expect(rendererFor(format).format).toBe(format);
        }
    });
});

describe("CompactRenderer", () => {
    test("one numbered block per turn, results folded into their call line", () => {
        const { ctx, lines, status } = capture();
        const renderer = rendererFor("compact");
        renderer.envelope(envelopeOf(turns), ctx);
        renderer.close(ctx);

        expect(lines).toEqual([
            "#1 🧠 The user wants a plan. Read the brief first.",
            "#1 💬 I'll read the spec first.",
            "#1 🔧 read_file /tmp/project/docs/Spec.md → ok · 49 chars · 1→--- 2→created: 2026-09-04 17:40 3→--- 4→# Spec",
            "#1 🔧 run_terminal_command date '+%Y-%m-%d %H:%M' && ls docs → ok exit 0 · 25 chars · 2026-09-04 17:50 Spec.md",
            "#2 🧠 Spec is long; grep the headings.",
            "#2 💬 Pulling the headings next.",
            "#2 🔧 grep /tmp/project/docs/Spec.md → FAILED · 44 chars · User cancelled the execution for tool `grep`",
            "#3 🧠 Third call, never finished.",
            '#4 ✖ error: Internal error: { "message": "API error (status 403 Forbidden): permission-denied: Your team 00000000-0000-4000-8000-000000000000 has either used all available credits or reached its monthly spending limit.", "http_status": 403 }',
        ]);
        expect(status).toEqual([
            "── 2 model calls · in 45.1K (cache 42.5K) · out 757 (reasoning 400) · ended: error",
            "── turns 1-4 · next window: --offset 4",
        ]);
    });

    test("thoughts none hides reasoning; full keeps it whole", () => {
        const none = capture({ thoughts: "none" });
        rendererFor("compact").envelope(envelopeOf(turns), none.ctx);
        expect(none.lines.some((line) => line.includes("🧠"))).toBe(false);

        const full = capture({ thoughts: "full" });
        rendererFor("compact").envelope(envelopeOf(turns), full.ctx);
        expect(full.lines[0]).toBe("#1 🧠 The user wants a plan. Read the brief first.");
    });

    test("follow mode prints a turn once, holds the growing last turn, and prints late results as ↩ lines", () => {
        const { ctx, lines, status } = capture({ follow: true });
        const renderer = rendererFor("compact");

        // First envelope: one settled turn whose tool has no result yet, and a growing second turn.
        const first: TranscriptTurn = {
            id: "a",
            role: "assistant",
            at: null,
            text: "Reading.",
            tools: [{ id: "t1", name: "read_file", inputPreview: "x.md", result: null, isError: false }],
        };
        const growing: TranscriptTurn = { id: "b", role: "assistant", at: null, text: "Partial", tools: [] };
        renderer.envelope(envelopeOf([first, growing], { terminated: null }), ctx);
        expect(lines).toEqual(["#1 💬 Reading.", "#1 🔧 read_file x.md"]);

        // Second envelope: the result landed, the second turn finished, a third is growing.
        const firstDone = { ...first, tools: [{ ...first.tools[0], result: "hello", resultChars: 5 }] };
        const second = { ...growing, text: "Partial answer done." };
        const third: TranscriptTurn = { id: "c", role: "assistant", at: null, text: "More", tools: [] };
        renderer.envelope(envelopeOf([firstDone, second, third], { terminated: null }), ctx);
        expect(lines.slice(2)).toEqual(["#1 ↩ read_file → ok · 5 chars · hello", "#2 💬 Partial answer done."]);

        expect(status).toEqual([]);
        renderer.close(ctx);
        expect(status.at(-1)).toBe("── turns 1-3 · next window: --offset 3");
    });
});

describe("JsonRenderer and JsonlRenderer", () => {
    test("json hands the envelope to result once", () => {
        const { ctx, results, lines } = capture();
        rendererFor("json").envelope(envelopeOf(turns), ctx);
        expect(results).toHaveLength(1);
        expect(lines).toEqual([]);
    });

    test("jsonl prints one strict JSON line per turn and a totals record", () => {
        const { ctx, lines } = capture();
        const renderer = rendererFor("jsonl");
        renderer.envelope(envelopeOf(turns), ctx);

        expect(lines).toHaveLength(turns.length + 1);
        const parsed = lines.map((line) => SafeJSON.parse(line, { strict: true }) as Record<string, unknown>);
        expect(parsed[0]?.id).toBe("sess-turn-1-step-1");
        expect(parsed.at(-1)).toMatchObject({ kind: "totals", modelCalls: 2, terminated: "error", nextOffset: 4 });
    });
});

describe("EventsRenderer", () => {
    test("uses the shared worker-event vocabulary with no delta lines", () => {
        const { ctx, lines } = capture();
        rendererFor("events").envelope(envelopeOf(turns), ctx);

        expect(lines).toEqual([
            "🧠 The user wants a plan. Read the brief first.",
            "💬 I'll read the spec first.",
            "🔧 read_file /tmp/project/docs/Spec.md",
            "↩ read_file",
            "🔧 run_terminal_command date '+%Y-%m-%d %H:%M' && ls docs",
            "↩ run_terminal_command",
            "🧠 Spec is long; grep the headings.",
            "💬 Pulling the headings next.",
            "🔧 grep /tmp/project/docs/Spec.md",
            "↩ grep FAILED",
            "🧠 Third call, never finished.",
            expect.stringContaining("✖ error: Internal error"),
        ]);
    });
});

describe("RawRenderer", () => {
    test("prints the file's own lines, and in follow mode only the appended bytes", () => {
        const dir = mkdtempSync(join(tmpdir(), "raw-render-"));
        const path = join(dir, "t.turn1.jsonl");
        writeFileSync(path, '{"type":"text","data":"a"}\n');

        const { ctx, lines } = capture({ follow: true });
        const renderer = rendererFor("raw");
        renderer.envelope(envelopeOf([], { filePath: path }), ctx);
        expect(lines).toEqual(['{"type":"text","data":"a"}']);

        writeFileSync(path, '{"type":"text","data":"a"}\n{"type":"end"}\n');
        renderer.envelope(envelopeOf([], { filePath: path }), ctx);
        expect(lines).toEqual(['{"type":"text","data":"a"}', '{"type":"end"}']);
    });
});
