import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/**
 * `tools ai sessions report <id>` (design 2026-11-01, step U12, proposal 2, first in its port order): one session's
 * cost, tokens, costliest calls and cache losses, from its reader's analysis facts, for Claude, Codex and Grok alike.
 */
export function registerSessionsReportCommand(sessions: Command): void {
    sessions
        .command("report <session-id>")
        .description(
            "One session's cost by model, main loop and sub-agents, its costliest calls and why, and its cache losses"
        )
        .option("--provider <name>", "claude | grok | codex (auto-detect if omitted)")
        .option("--top <n>", "How many of the costliest calls to list (default 10)")
        .option("--json", `Print { schema: "sessions.report@1", session, report }`)
        .action(async (sessionId: string, opts: { provider?: string; top?: string; json?: boolean }) => {
            if (opts.provider !== undefined && !isAccountProviderAlias(opts.provider)) {
                out.printlnErr(`--provider must be claude, codex or grok (got "${opts.provider}")`);
                process.exitCode = 1;
                return;
            }

            const top = opts.top === undefined ? 10 : Number(opts.top);

            if (!Number.isInteger(top) || top < 1) {
                out.printlnErr(`--top "${opts.top}" is not a positive whole number.`);
                process.exitCode = 1;
                return;
            }

            let session: ResolvedTranscript;

            try {
                session = await resolveTranscript(sessionId, {}, opts.provider);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
                return;
            }

            // Lazy: the pricing catalog and the readers load only for this verb, not for every `tools ai sessions`.
            const { printSessionReport } = await import("@app/ai/lib/sessions/session-report");
            await printSessionReport(session, { top, ...(opts.json ? { json: true } : {}) });
        });
}
