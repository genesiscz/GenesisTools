import { formatTokens } from "@genesiscz/utils/format";
import type { TranscriptEnvelope, TranscriptTool, TranscriptTurn } from "../types";
import { type RenderContext, settledTurns, TranscriptRenderer, windowStart } from "./renderer";

const SHORT_THOUGHT_CHARS = 200;
const TARGET_CHARS = 160;
const ERROR_CHARS = 400;

export function oneLine(text: string, max: number): string {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function resultSuffix(tool: TranscriptTool, ctx: RenderContext): string {
    const status = tool.isError ? "FAILED" : "ok";
    const exit = tool.exitCode !== undefined ? ` exit ${tool.exitCode}` : "";
    const chars = tool.resultChars ?? tool.result?.length ?? 0;
    const preview = tool.result ? ` · ${oneLine(tool.result, ctx.previewChars)}` : "";
    return `→ ${status}${exit} · ${formatTokens(chars)} chars${preview}`;
}

function callLine(tag: string, tool: TranscriptTool, ctx: RenderContext, withResult: boolean): string {
    const target = tool.inputPreview ? ` ${oneLine(tool.inputPreview, TARGET_CHARS)}` : "";
    const result = withResult ? ` ${resultSuffix(tool, ctx)}` : "";
    return `${tag} 🔧 ${tool.name}${target}${result}`;
}

function eventLine(tag: string, turn: TranscriptTurn): string {
    const event = turn.event;
    if (event?.kind === "end") {
        return `${tag} ✔ end (${event.stopReason})${event.costUsd !== undefined ? ` $${event.costUsd.toFixed(4)}` : ""}`;
    }

    if (event?.kind === "error") {
        return `${tag} ✖ error: ${oneLine(event.message, ERROR_CHARS)}`;
    }

    if (event?.kind === "turn.started") {
        return `${tag} ▶ turn ${event.turn} started`;
    }

    return `${tag} ⚑ ${oneLine(turn.text, ERROR_CHARS)}`;
}

export function formatTotals(envelope: TranscriptEnvelope): string {
    const totals = envelope.totals;
    if (!totals) {
        return "";
    }

    const tokens =
        `in ${formatTokens(totals.inputTokens ?? 0)} (cache ${formatTokens(totals.cacheReadTokens ?? 0)}) · ` +
        `out ${formatTokens(totals.outputTokens ?? 0)} (reasoning ${formatTokens(totals.reasoningTokens ?? 0)})`;
    const cost = totals.costUsd !== undefined ? ` · $${totals.costUsd.toFixed(4)}` : "";
    const ended = envelope.terminated ?? "running";
    return `${totals.modelCalls} model calls · ${tokens}${cost} · ended: ${ended}`;
}

/**
 * One numbered block per turn, one line per message, thought, tool call and
 * terminal event. Readable by a human and cheap for an agent: a 954-line grok
 * turn log renders in about 80 lines. Tool results fold into their call line
 * when known; a result that lands later (follow mode) prints as its own `↩` line.
 */
export class CompactRenderer extends TranscriptRenderer {
    readonly format = "compact";
    private readonly printedTurns = new Set<string>();
    private readonly printedResults = new Set<string>();
    private last: TranscriptEnvelope | null = null;

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        this.last = envelope;
        const start = windowStart(envelope);

        for (const [index, turn] of settledTurns(envelope, ctx).entries()) {
            const tag = `#${start + index}`;

            if (!this.printedTurns.has(turn.id)) {
                this.printedTurns.add(turn.id);
                for (const line of this.turnLines(tag, turn, ctx)) {
                    ctx.write(line);
                }
            }

            for (const tool of turn.tools) {
                if (tool.result !== null && !this.printedResults.has(tool.id)) {
                    this.printedResults.add(tool.id);
                    ctx.write(`${tag} ↩ ${tool.name} ${resultSuffix(tool, ctx)}`);
                }
            }
        }

        if (!ctx.follow) {
            this.footer(envelope, ctx);
        }
    }

    close(ctx: RenderContext): void {
        if (ctx.follow && this.last) {
            this.footer(this.last, ctx);
        }
    }

    private turnLines(tag: string, turn: TranscriptTurn, ctx: RenderContext): string[] {
        if (turn.role === "system") {
            return [eventLine(tag, turn)];
        }

        const lines: string[] = [];
        if (turn.reasoning && ctx.thoughts !== "none") {
            const text = ctx.thoughts === "full" ? turn.reasoning.trim() : oneLine(turn.reasoning, SHORT_THOUGHT_CHARS);
            lines.push(`${tag} 🧠 ${text}`);
        }

        if (turn.text.trim()) {
            lines.push(`${tag} ${turn.role === "user" ? "👤" : "💬"} ${turn.text.trim()}`);
        }

        for (const tool of turn.tools) {
            const known = tool.result !== null;
            if (known) {
                this.printedResults.add(tool.id);
            }

            lines.push(callLine(tag, tool, ctx, known));
        }

        return lines;
    }

    private footer(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        const totals = formatTotals(envelope);
        if (totals) {
            ctx.status(`── ${totals}`);
        }

        ctx.status(
            `── turns ${windowStart(envelope)}-${envelope.nextOffset} · next window: --offset ${envelope.nextOffset}`
        );
    }
}
