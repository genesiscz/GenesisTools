import { formatWorkerEvent, type WorkerEvent } from "@genesiscz/utils/worker/events";
import type { TranscriptEnvelope, TranscriptTurn } from "../types";
import { oneLine, SHORT_THOUGHT_CHARS } from "./compact";
import { type RenderContext, settledTurns, TranscriptRenderer } from "./renderer";

/** Reasoning text under the context's thoughts mode, or null when it is hidden. */
function reasoningText(turn: TranscriptTurn, ctx: RenderContext): string | null {
    if (!turn.reasoning || ctx.thoughts === "none") {
        return null;
    }

    return ctx.thoughts === "full" ? turn.reasoning.trim() : oneLine(turn.reasoning, SHORT_THOUGHT_CHARS);
}

/** A settled turn as the shared worker-event vocabulary, deltas already folded. */
export function turnToWorkerEvents(turn: TranscriptTurn, sessionId: string, ctx: RenderContext): WorkerEvent[] {
    const events: WorkerEvent[] = [];

    if (turn.role === "system") {
        const event = turn.event;
        if (event?.kind === "end") {
            events.push({
                kind: "turn.completed",
                sessionId,
                usage: event.costUsd !== undefined ? { totalCostUsd: event.costUsd } : undefined,
            });
        } else if (event?.kind === "error") {
            events.push({ kind: "error", sessionId, message: event.message });
        } else if (event?.kind === "turn.started") {
            events.push({ kind: "turn.started", sessionId, turn: event.turn });
        } else if (turn.text.trim()) {
            events.push({ kind: "text", sessionId, text: turn.text.trim(), delta: false });
        }

        return events;
    }

    const reasoning = reasoningText(turn, ctx);
    if (reasoning) {
        events.push({ kind: "reasoning", sessionId, text: reasoning, delta: false });
    }

    if (turn.text.trim()) {
        events.push({ kind: "text", sessionId, text: turn.text.trim(), delta: false });
    }

    for (const tool of turn.tools) {
        events.push({ kind: "tool_call", sessionId, tool: tool.name, target: tool.inputPreview, callId: tool.id });
        if (tool.result !== null) {
            events.push({ kind: "tool_result", sessionId, tool: tool.name, callId: tool.id, ok: !tool.isError });
        }
    }

    return events;
}

/** The `--events` view every backend shares (`formatWorkerEvent`), fed from turns so no delta ever prints. */
export class EventsRenderer extends TranscriptRenderer {
    readonly format = "events";
    private readonly printedTurns = new Set<string>();
    private readonly printedResults = new Set<string>();

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        for (const turn of settledTurns(envelope, ctx)) {
            if (this.printedTurns.has(turn.id)) {
                // A turn is re-emitted on every reparse. Its tool results can
                // arrive after it settled, so the turn being printed already is
                // NOT a reason to drop them (PR #364 review).
                this.emitLateResults(turn, envelope.sessionId, ctx);
                continue;
            }

            this.printedTurns.add(turn.id);
            for (const event of turnToWorkerEvents(turn, envelope.sessionId, ctx)) {
                if (event.kind === "tool_result" && event.callId) {
                    this.printedResults.add(event.callId);
                }

                const line = formatWorkerEvent(event);
                if (line) {
                    ctx.write(line);
                }
            }
        }
    }

    private emitLateResults(turn: TranscriptTurn, sessionId: string, ctx: RenderContext): void {
        for (const tool of turn.tools) {
            if (tool.result === null || this.printedResults.has(tool.id)) {
                continue;
            }

            this.printedResults.add(tool.id);
            const line = formatWorkerEvent({
                kind: "tool_result",
                sessionId,
                tool: tool.name,
                callId: tool.id,
                ok: !tool.isError,
            });
            if (line) {
                ctx.write(line);
            }
        }
    }
}
