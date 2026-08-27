/**
 * CLI command: `claude-history summarize [session-id]`
 *
 * Registration only — the implementation (engine, model selector, session
 * libs, ~160ms of imports) lives in ./summarize-impl and loads when the
 * command actually runs.
 */

import type { Command } from "commander";
import type { SummarizeCommandOptions } from "./summarize-impl";

export function registerSummarizeCommand(program: Command): void {
    program
        .command("summarize [session-id]")
        .description("Summarize a Claude Code session using LLM-powered templates")
        .option(
            "-s, --session <id>",
            "Session ID (repeatable)",
            (val: string, prev: string[]) => {
                prev.push(val);
                return prev;
            },
            [] as string[]
        )
        .option("--current", "Use current session ($CLAUDE_CODE_SESSION_ID)")
        .option("--since <date>", "Sessions since date")
        .option("--until <date>", "Sessions until date")
        .option("-m, --mode <name>", "Template mode (default: documentation)")
        .option("--model <name>", "LLM model")
        .option("--provider <name>", "LLM provider")
        .option("--prompt-only", "Output prompt without calling LLM")
        .option("-o, --output <path>", "Write to file")
        .option("--clipboard", "Copy to clipboard")
        .option("--thorough", "Chunked summarization for large sessions")
        .option("--max-tokens <n>", "Token budget (default: 128000)")
        .option("--include-tool-results", "Include tool results in extraction")
        .option("--include-thinking", "Include thinking blocks")
        .option("--priority <type>", "balanced|summary-first|user-first|assistant-first (default: balanced)")
        .option("-i, --interactive", "Interactive flow with prompts")
        .option("--custom-prompt <text>", "Custom prompt text (for custom mode)")
        .option("--memory-dir <path>", "Output dir for memorization topic files")
        .option("--apple-notes", "Save to Apple Notes (interactive folder picker)")
        .option("--project <path>", "Project path (e.g. ../widgets/web-app/)")
        .action(async (sessionId: string | undefined, cmdOpts: SummarizeCommandOptions) => {
            const { runSummarizeCommand } = await import("./summarize-impl");
            await runSummarizeCommand(sessionId, cmdOpts);
        });
}
