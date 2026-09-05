import { runTranscriptDoor } from "@genesiscz/utils/ai/transcripts/door";
import { THOUGHT_MODES, TRANSCRIPT_FORMATS } from "@genesiscz/utils/ai/transcripts/render";
import { DEFAULT_TURN_LIMIT, type TranscriptProvider } from "@genesiscz/utils/ai/transcripts/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

const PROVIDERS = new Set<TranscriptProvider>(["claude", "grok", "codex"]);

function parseProvider(value: string | undefined): TranscriptProvider | undefined {
    if (!value) {
        return undefined;
    }
    if (!PROVIDERS.has(value as TranscriptProvider)) {
        throw new Error(`--provider must be claude, grok, or codex (got "${value}")`);
    }
    return value as TranscriptProvider;
}

export function registerSessionsCommands(program: Command): void {
    const sessions = program.command("sessions").description("Replay Claude, Grok, and Codex session JSONL");

    sessions
        .command("tail <session-id>")
        .description("Dump or follow a session (a worker name or a session id) as unified turns")
        .option("--format [value]", `output shape: ${TRANSCRIPT_FORMATS.join(" | ")} (default compact)`)
        .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`)
        .option("--json", "alias of --format json (the Genesis Session Details envelope)")
        .option("-f, --follow", "Follow the JSONL for new turns until Ctrl-C")
        .option("--provider <name>", "claude | grok | codex (auto-detect if omitted)")
        .option("--offset <n>", "Start at this turn index (default: last --limit turns)")
        .option("--limit <n>", "Max turns to emit", String(DEFAULT_TURN_LIMIT))
        .action(
            async (
                sessionId: string,
                opts: {
                    format?: string | boolean;
                    thoughts?: string | boolean;
                    json?: boolean;
                    follow?: boolean;
                    provider?: string;
                    offset?: string;
                    limit?: string;
                }
            ) => {
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

                let provider: TranscriptProvider | undefined;
                try {
                    provider = parseProvider(opts.provider);
                } catch (error) {
                    process.exitCode = 2;
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    return;
                }

                await runTranscriptDoor({
                    tool: "tools ai sessions tail",
                    subcommand: ["sessions", "tail"],
                    provider,
                    query: sessionId,
                    format: opts.format,
                    thoughts: opts.thoughts,
                    json: opts.json,
                    slice: { offset, limit },
                    follow: opts.follow === true,
                });
            }
        );
}
