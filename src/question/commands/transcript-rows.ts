import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/**
 * `tools question transcript-rows`: where a session's decisions were first asked and its question tool calls, from
 * the shared incremental index (`lib/decisions/transcript-rows.ts`). The mods' "jump to" reads this instead of
 * grepping the transcript in every session.
 */
export function registerTranscriptRowsCommand(program: Command): void {
    program
        .command("transcript-rows")
        .description(
            "A transcript's decision rows: the row of each ❓ DECISION N first ask and the question tool calls with their times. Reads only what was appended since the last call (index shared by every caller)"
        )
        .option("--transcript <path>", "The session's transcript file")
        .option("--session <id>", "The session id, when the transcript path is not known (looked up, slower)")
        .option("--provider <kind>", "claude, codex or grok (default: the looked-up session's, else claude)")
        .option("--json", "Print { transcript, provider, file, offset, scanned, asks, calls, issues }")
        .action(async (options: { transcript?: string; session?: string; provider?: string; json?: boolean }) => {
            let transcript = options.transcript;
            let provider = options.provider;

            if (!transcript && options.session) {
                const { resolveTranscript } = await import("@genesiscz/utils/ai/transcripts/resolve");
                const resolved = await resolveTranscript(options.session);
                transcript = resolved.filePath;
                provider ??= resolved.provider;
            }

            if (!transcript) {
                out.printlnErr("transcript-rows needs --transcript <path> or --session <id>");
                process.exitCode = 1;
                return;
            }

            const { transcriptRows } = await import("../lib/decisions/transcript-rows");
            const rows = await transcriptRows({ transcript, provider: provider ?? "claude" });

            if (options.json) {
                out.result(rows);
                return;
            }

            out.println(`${rows.transcript} (${rows.provider}) read ${rows.scanned.from} to ${rows.scanned.to}`);

            for (const ask of rows.asks) {
                out.println(`DECISION ${ask.number}  ${ask.row}`);
            }

            out.println(`${rows.calls.length} question tool calls`);
        });
}
