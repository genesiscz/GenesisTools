import { claudeTranscriptEnvelope } from "@genesiscz/utils/ai/transcripts/claude";
import { DEFAULT_TURN_LIMIT } from "@genesiscz/utils/ai/transcripts/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/**
 * A transcript is untrusted content replayed into a terminal: ANSI and OSC
 * sequences in it would be interpreted, not shown (PR #343 review t13).
 * Strips C0/C1 controls except tab and newline.
 */
export function safeForTerminal(value: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/**
 * `Number.parseInt` takes a numeric PREFIX, so "12x" became 12 and "1.5" became
 * 1 (PR #343 review t12). Demand a whole decimal string instead.
 */
export function wholeNumber(raw: string): number {
    return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

export function registerTranscriptCommand(program: Command): void {
    program
        .command("transcript <session-id>")
        .description("Replay a Claude session JSONL as JSON turns for Session Details")
        .option("--json", "Output as JSON (required for the Genesis window)")
        .option("--offset <n>", "Start at this turn index (default: last --limit turns)")
        .option("--limit <n>", "Max turns to emit", String(DEFAULT_TURN_LIMIT))
        .action(async (sessionId: string, opts: { json?: boolean; offset?: string; limit?: string }) => {
            const limit = wholeNumber(opts.limit ?? String(DEFAULT_TURN_LIMIT));
            const offset = opts.offset === undefined ? undefined : wholeNumber(opts.offset);
            if (!Number.isFinite(limit) || limit < 1) {
                process.exitCode = 2;
                out.printlnErr("--limit must be a positive integer");
                return;
            }
            if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
                process.exitCode = 2;
                out.printlnErr("--offset must be a non-negative integer");
                return;
            }
            try {
                const envelope = await claudeTranscriptEnvelope(sessionId, { offset, limit });
                if (opts.json) {
                    out.result(envelope);
                    return;
                }
                for (const turn of envelope.turns) {
                    const tools = turn.tools.map((t) => `${t.name}(${safeForTerminal(t.inputPreview)})`).join(", ");
                    out.println(`${turn.role}: ${safeForTerminal(turn.text)}${tools ? ` [${tools}]` : ""}`);
                }
            } catch (error) {
                process.exitCode = 1;
                out.printlnErr(error instanceof Error ? error.message : String(error));
            }
        });
}
