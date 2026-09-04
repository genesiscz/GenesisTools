import { out } from "@genesiscz/utils/logger";
import type { TranscriptEnvelope, TranscriptTurn } from "../types";

export const TRANSCRIPT_FORMATS = ["compact", "json", "jsonl", "events", "raw"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

export const THOUGHT_MODES = ["none", "short", "full"] as const;
export type ThoughtMode = (typeof THOUGHT_MODES)[number];

export function isTranscriptFormat(value: string): value is TranscriptFormat {
    return (TRANSCRIPT_FORMATS as readonly string[]).includes(value);
}

export function isThoughtMode(value: string): value is ThoughtMode {
    return (THOUGHT_MODES as readonly string[]).includes(value);
}

/** Where a renderer writes. Tests inject captures; the CLI uses `out`. */
export interface RenderContext {
    /** One line of the rendered transcript: the result, stdout. */
    write(line: string): void;
    /** One line of status around the transcript (header, footer, hints): stderr. */
    status(line: string): void;
    /** The whole machine-readable result, for the json format. */
    result(value: unknown): void;
    thoughts: ThoughtMode;
    /** Characters of a tool result shown inline by the compact format. */
    previewChars: number;
    /** Envelopes keep arriving until `close()`; the last turn may still be growing. */
    follow: boolean;
}

export function defaultRenderContext(overrides: Partial<RenderContext> = {}): RenderContext {
    return {
        write: (line) => out.println(line),
        status: (line) => out.printlnErr(line),
        result: (value) => out.result(value),
        thoughts: "short",
        previewChars: 160,
        follow: false,
        ...overrides,
    };
}

/**
 * One transcript, one output shape. `envelope()` is called once for a static
 * dump and once per change in follow mode (`followTranscript` re-parses the
 * whole file, so every call carries the full window, not a delta); a renderer
 * that prints incrementally remembers what it already wrote.
 */
export abstract class TranscriptRenderer {
    abstract readonly format: TranscriptFormat;

    open(_ctx: RenderContext): void {}

    abstract envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void;

    close(_ctx: RenderContext): void {}
}

/**
 * The turns a line-oriented renderer may print now. In follow mode the last
 * turn is still receiving deltas unless the transcript has terminated, so it
 * waits for its successor.
 */
export function settledTurns(envelope: TranscriptEnvelope, ctx: RenderContext): TranscriptTurn[] {
    if (!ctx.follow || envelope.terminated) {
        return envelope.turns;
    }

    return envelope.turns.slice(0, -1);
}

/** Absolute 1-based index of the first turn in this window. */
export function windowStart(envelope: TranscriptEnvelope): number {
    return envelope.nextOffset - envelope.turns.length + 1;
}
