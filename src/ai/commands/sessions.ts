import { transcriptEnvelope } from "@genesiscz/utils/ai/transcripts/load";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { followTranscript } from "@genesiscz/utils/ai/transcripts/tail";
import {
    DEFAULT_TURN_LIMIT,
    type TranscriptEnvelope,
    type TranscriptProvider,
} from "@genesiscz/utils/ai/transcripts/types";
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

function printHuman(envelope: TranscriptEnvelope): void {
    for (const turn of envelope.turns) {
        const tools = turn.tools.map((t) => `${t.name}(${t.inputPreview})`).join(", ");
        out.println(`${turn.role}: ${turn.text}${tools ? ` [${tools}]` : ""}`);
    }
}

export function registerSessionsCommands(program: Command): void {
    const sessions = program.command("sessions").description("Replay Claude, Grok, and Codex session JSONL");

    sessions
        .command("tail <session-id>")
        .description("Dump or follow a session JSONL as unified turns")
        .option("--json", "JSON envelope (Genesis Session Details)")
        .option("-f, --follow", "Follow the JSONL for new turns")
        .option("--provider <name>", "claude | grok | codex (auto-detect if omitted)")
        .option("--offset <n>", "Start at this turn index (default: last --limit turns)")
        .option("--limit <n>", "Max turns to emit", String(DEFAULT_TURN_LIMIT))
        .action(
            async (
                sessionId: string,
                opts: {
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

                const follow = opts.follow === true;
                const slice = { offset, limit };

                try {
                    const resolved = await resolveTranscript(sessionId, {}, provider);
                    const emit = (envelope: Awaited<ReturnType<typeof transcriptEnvelope>>): void => {
                        if (opts.json) {
                            out.result(envelope);
                            return;
                        }
                        printHuman(envelope);
                    };

                    if (!follow) {
                        emit(await transcriptEnvelope(resolved, slice));
                        return;
                    }

                    const ac = new AbortController();
                    process.once("SIGINT", () => ac.abort());
                    await followTranscript(resolved, {
                        slice,
                        signal: ac.signal,
                        onEnvelope: emit,
                    });
                } catch (error) {
                    process.exitCode = 1;
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                }
            }
        );
}
