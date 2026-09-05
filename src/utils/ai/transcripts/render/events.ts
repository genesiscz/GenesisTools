import { formatWorkerEvent, type WorkerEvent } from "@genesiscz/utils/worker/events";
import type { TranscriptEnvelope, TranscriptTurn } from "../types";
import { type RenderContext, settledTurns, TranscriptRenderer } from "./renderer";

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

    if (turn.reasoning && ctx.thoughts !== "none") {
        events.push({ kind: "reasoning", sessionId, text: turn.reasoning.trim(), delta: false });
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
    private readonly printed = new Set<string>();

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        for (const turn of settledTurns(envelope, ctx)) {
            if (this.printed.has(turn.id)) {
                continue;
            }

            this.printed.add(turn.id);
            for (const event of turnToWorkerEvents(turn, envelope.sessionId, ctx)) {
                const line = formatWorkerEvent(event);
                if (line) {
                    ctx.write(line);
                }
            }
        }
    }
}
