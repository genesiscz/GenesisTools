import { SafeJSON } from "@genesiscz/utils/json";
import type { TranscriptEnvelope, TranscriptTurn } from "../types";
import { type RenderContext, settledTurns, TranscriptRenderer } from "./renderer";

/** The whole envelope as one JSON document (what `--json` always printed). In follow mode every change re-emits it. */
export class JsonRenderer extends TranscriptRenderer {
    readonly format = "json";

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        ctx.result(envelope);
    }
}

function hasPendingTool(turn: TranscriptTurn): boolean {
    return turn.tools.some((tool) => tool.result === null);
}

/**
 * One JSON object per line: each turn once, then a `totals` record. The
 * streamed shape an agent can `tail -f` or pipe without holding the file.
 *
 * A turn is written exactly once, so in follow mode a settled turn whose tool
 * is still running is held back until its result lands (or the follow ends);
 * writing it early froze `result: null` into the stream (PR #364 review).
 */
export class JsonlRenderer extends TranscriptRenderer {
    readonly format = "jsonl";
    private readonly printed = new Set<string>();
    private last: TranscriptEnvelope | null = null;

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        this.last = envelope;
        const holdPending = ctx.follow && !envelope.terminated;
        for (const turn of settledTurns(envelope, ctx)) {
            if (this.printed.has(turn.id) || (holdPending && hasPendingTool(turn))) {
                continue;
            }

            this.write(turn, ctx);
        }

        if (!ctx.follow) {
            this.totals(envelope, ctx);
        }
    }

    close(ctx: RenderContext): void {
        if (!ctx.follow || !this.last) {
            return;
        }

        // The follow is over: whatever is still held back goes out as it is.
        for (const turn of this.last.turns) {
            if (!this.printed.has(turn.id)) {
                this.write(turn, ctx);
            }
        }

        this.totals(this.last, ctx);
    }

    private write(turn: TranscriptTurn, ctx: RenderContext): void {
        this.printed.add(turn.id);
        ctx.write(SafeJSON.stringify(turn, { strict: true }));
    }

    private totals(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        ctx.write(
            SafeJSON.stringify(
                {
                    kind: "totals",
                    ...envelope.totals,
                    terminated: envelope.terminated ?? null,
                    nextOffset: envelope.nextOffset,
                },
                { strict: true }
            )
        );
    }
}
