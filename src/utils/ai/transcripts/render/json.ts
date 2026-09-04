import { SafeJSON } from "@genesiscz/utils/json";
import type { TranscriptEnvelope } from "../types";
import { type RenderContext, settledTurns, TranscriptRenderer } from "./renderer";

/** The whole envelope as one JSON document (what `--json` always printed). In follow mode every change re-emits it. */
export class JsonRenderer extends TranscriptRenderer {
    readonly format = "json";

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        ctx.result(envelope);
    }
}

/**
 * One JSON object per line: each settled turn once, then a `totals` record.
 * The streamed shape an agent can `tail -f` or pipe without holding the file.
 */
export class JsonlRenderer extends TranscriptRenderer {
    readonly format = "jsonl";
    private readonly printed = new Set<string>();
    private last: TranscriptEnvelope | null = null;

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        this.last = envelope;
        for (const turn of settledTurns(envelope, ctx)) {
            if (this.printed.has(turn.id)) {
                continue;
            }

            this.printed.add(turn.id);
            ctx.write(SafeJSON.stringify(turn, { strict: true }));
        }

        if (!ctx.follow) {
            this.totals(envelope, ctx);
        }
    }

    close(ctx: RenderContext): void {
        if (ctx.follow && this.last) {
            this.totals(this.last, ctx);
        }
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
