import { claudeTranscriptEnvelope } from "@genesiscz/utils/ai/transcripts/claude";
import { DEFAULT_TURN_LIMIT } from "@genesiscz/utils/ai/transcripts/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerTranscriptCommand(program: Command): void {
    program
        .command("transcript <session-id>")
        .description("Replay a Claude session JSONL as JSON turns for Session Details")
        .option("--json", "Output as JSON (required for the Genesis window)")
        .option("--offset <n>", "Start at this turn index (default: last --limit turns)")
        .option("--limit <n>", "Max turns to emit", String(DEFAULT_TURN_LIMIT))
        .action(async (sessionId: string, opts: { json?: boolean; offset?: string; limit?: string }) => {
            const limit = Number.parseInt(opts.limit ?? String(DEFAULT_TURN_LIMIT), 10);
            const offset = opts.offset === undefined ? undefined : Number.parseInt(opts.offset, 10);
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
                    const tools = turn.tools.map((t) => `${t.name}(${t.inputPreview})`).join(", ");
                    out.println(`${turn.role}: ${turn.text}${tools ? ` [${tools}]` : ""}`);
                }
            } catch (error) {
                process.exitCode = 1;
                out.printlnErr(error instanceof Error ? error.message : String(error));
            }
        });
}
