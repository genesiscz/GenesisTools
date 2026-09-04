import { transcriptEnvelope } from "@genesiscz/utils/ai/transcripts/load";
import {
    defaultRenderContext,
    isThoughtMode,
    isTranscriptFormat,
    rendererFor,
    THOUGHT_MODES,
    type ThoughtMode,
    TRANSCRIPT_FORMATS,
    type TranscriptFormat,
} from "@genesiscz/utils/ai/transcripts/render";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { followTranscript } from "@genesiscz/utils/ai/transcripts/tail";
import { DEFAULT_TURN_LIMIT, type TranscriptProvider } from "@genesiscz/utils/ai/transcripts/types";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";

const TOOL = "tools ai sessions tail";
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

/**
 * An enumerated flag declared `--flag [value]`: absent → the default; bare in a
 * TTY → a picker; bare elsewhere, or an unknown value → the possible values and
 * a filled-in command line, exit 1 (CLAUDE.md "Enumerated flags").
 */
async function pickEnum<T extends string>(input: {
    flag: string;
    given: string | boolean | undefined;
    values: readonly T[];
    fallback: T;
    accepts: (value: string) => value is T;
    sessionId: string;
}): Promise<T | null> {
    const { flag, given, values, fallback, accepts } = input;
    if (given === undefined || given === false) {
        return fallback;
    }

    if (typeof given === "string" && accepts(given)) {
        return given;
    }

    if (given === true && isInteractive()) {
        const picked = String(
            await p.select({
                message: `${flag} value`,
                options: values.map((value) => ({ value, label: value })),
            })
        );
        return accepts(picked) ? picked : null;
    }

    out.printlnErr(
        suggestEnumFlag(TOOL, flag, values, {
            subcommand: ["sessions", "tail"],
            given: typeof given === "string" ? given : undefined,
        })
    );
    process.exitCode = 1;
    return null;
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

                const format = await pickEnum<TranscriptFormat>({
                    flag: "--format",
                    given: opts.format,
                    values: TRANSCRIPT_FORMATS,
                    fallback: opts.json ? "json" : "compact",
                    accepts: isTranscriptFormat,
                    sessionId,
                });
                const thoughts = await pickEnum<ThoughtMode>({
                    flag: "--thoughts",
                    given: opts.thoughts,
                    values: THOUGHT_MODES,
                    fallback: "short",
                    accepts: isThoughtMode,
                    sessionId,
                });
                if (format === null || thoughts === null) {
                    return;
                }

                const follow = opts.follow === true;
                const slice = { offset, limit };
                const renderer = rendererFor(format);
                const ctx = defaultRenderContext({ thoughts, follow });

                try {
                    const resolved = await resolveTranscript(sessionId, {}, provider);
                    renderer.open(ctx);

                    if (!follow) {
                        renderer.envelope(await transcriptEnvelope(resolved, slice), ctx);
                        renderer.close(ctx);
                        return;
                    }

                    const ac = new AbortController();
                    process.once("SIGINT", () => ac.abort());
                    await followTranscript(resolved, {
                        slice,
                        signal: ac.signal,
                        onEnvelope: (envelope) => renderer.envelope(envelope, ctx),
                    });
                    renderer.close(ctx);
                } catch (error) {
                    process.exitCode = 1;
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                }
            }
        );
}
