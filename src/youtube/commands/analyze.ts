import { isInteractive } from "@app/utils/cli/executor";
import { loadAskProviderChoice } from "@app/youtube/commands/_shared/ask-provider";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { formatSummary, resolveTargetsToVideoIds } from "@app/youtube/commands/_shared/utils";
import type { TimestampedSummaryEntry, VideoId } from "@app/youtube/lib/types";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface AnalyzeOpts {
    summary?: boolean;
    timestamped?: boolean;
    ask?: string;
    topK: number;
    stream?: boolean;
    provider?: string;
    model?: string;
    targetBins?: number;
    yes?: boolean;
}

interface SummaryRow {
    videoId: VideoId;
    result: {
        short?: string;
        timestamped?: TimestampedSummaryEntry[];
    };
}

export function registerAnalyzeCommand(program: Command): void {
    const cmd = program
        .command("analyze")
        .description("Summarise a video or ask a question across one or more transcripts")
        .argument("<targets...>", "Video IDs, URLs, or @handles")
        .option("--summary", "Generate a short summary (default mode)")
        .option("--timestamped", "Generate a timestamped summary instead of a short one")
        .option("--ask <question>", "Ask a question over the transcript(s)")
        .option("--top-k <n>", "QA: number of context chunks to retrieve", (value) => Number.parseInt(value, 10), 8)
        .option("--stream", "QA: stream the LLM answer to stdout as it generates")
        .option("--provider <name>", "Override AI provider for QA / timestamped summary (e.g. claude, openai, ollama)")
        .option("--model <id>", "Override model for QA / timestamped summary")
        .option("--target-bins <n>", "Timestamped: approximate number of summary entries", (value) =>
            Number.parseInt(value, 10)
        )
        .option("-y, --yes", "Skip the LLM confirmation prompt (assume yes)")
        .addHelpText("after", buildAnalyzeExamples())
        .action(async (targets: string[], opts: AnalyzeOpts) => {
            if (opts.ask && (opts.summary || opts.timestamped)) {
                console.error(pc.red("--ask is mutually exclusive with --summary/--timestamped"));
                process.exitCode = 1;
                return;
            }

            const yt = await getYoutube();
            const ids = await resolveTargetsToVideoIds(yt, targets);

            const action = opts.ask ? "ask" : opts.timestamped ? "timestamped" : "summary";
            const proceed = await confirmLlmCall({
                action,
                ids,
                provider: opts.provider,
                model: opts.model,
                topK: opts.topK,
                question: opts.ask,
                yes: opts.yes,
            });

            if (!proceed) {
                console.error(pc.dim("Cancelled — no LLM call made."));
                process.exitCode = 1;
                return;
            }

            if (opts.ask) {
                for (const id of ids) {
                    await yt.qa.index({ videoId: id });
                }

                const result = await yt.qa.ask({
                    videoIds: ids,
                    question: opts.ask,
                    topK: opts.topK,
                    streaming: opts.stream,
                    providerChoice: await loadAskProviderChoice({ provider: opts.provider, model: opts.model }),
                    streamTarget: opts.stream ? process.stdout : undefined,
                });
                const citations = result.citations
                    .map((citation) => `${citation.videoId}#${citation.chunkIdx}`)
                    .join(", ");

                await renderOrEmit({
                    text: opts.stream ? "" : `${result.answer}\n\n${pc.dim("Citations:")} ${citations}`,
                    json: result,
                    flags: cmd.optsWithGlobals(),
                });
                return;
            }

            const mode = opts.timestamped ? "timestamped" : "short";
            const providerChoice =
                opts.provider || opts.model
                    ? await loadAskProviderChoice({ provider: opts.provider, model: opts.model })
                    : undefined;
            const rows: SummaryRow[] = [];

            for (const id of ids) {
                rows.push({
                    videoId: id,
                    result: await yt.summary.summarize({
                        videoId: id,
                        mode,
                        provider: opts.provider,
                        providerChoice,
                        targetBins: opts.targetBins,
                    }),
                });
            }

            await renderOrEmit({
                text: rows.map((row) => formatSummary(row.videoId, row.result, mode)).join("\n\n"),
                json: rows,
                flags: cmd.optsWithGlobals(),
            });
        });
}

function buildAnalyzeExamples(): string {
    return '\nExamples:\n  $ tools youtube analyze dQw4w9WgXcQ --summary\n  $ tools youtube analyze dQw4w9WgXcQ --timestamped\n  $ tools youtube analyze dQw4w9WgXcQ otherVideo123 --ask "what are the key claims?"\n  $ tools youtube analyze dQw4w9WgXcQ --summary --provider claude --model claude-haiku-4-5 -y\n';
}

interface ConfirmLlmOpts {
    action: "summary" | "timestamped" | "ask";
    ids: VideoId[];
    provider?: string;
    model?: string;
    topK?: number;
    question?: string;
    yes?: boolean;
}

async function confirmLlmCall(opts: ConfirmLlmOpts): Promise<boolean> {
    const lines: string[] = [];

    if (opts.action === "summary") {
        lines.push(
            pc.bold(`About to call your configured LLM to generate a SHORT summary for ${opts.ids.length} video(s).`)
        );
        lines.push(pc.dim(`  - one LLM call per video; sends the full transcript text.`));
    }

    if (opts.action === "timestamped") {
        lines.push(
            pc.bold(
                `About to call your configured LLM to generate a TIMESTAMPED summary for ${opts.ids.length} video(s).`
            )
        );
        lines.push(
            pc.dim(`  - exactly one LLM call per video; sends transcript with [MM:SS] markers and asks for JSON.`)
        );
    }

    if (opts.action === "ask") {
        lines.push(pc.bold(`About to call your configured LLM to answer a question over ${opts.ids.length} video(s).`));
        lines.push(
            pc.dim(
                `  - top-K=${opts.topK ?? 8} chunks per video, one LLM call. Question: ${pc.italic(`"${opts.question ?? ""}"`)}`
            )
        );
        lines.push(pc.dim(`  - chunk indexing also runs an embedding model if not already indexed.`));
    }

    if (opts.provider || opts.model) {
        lines.push(
            pc.cyan(
                `  - Provider override: ${opts.provider ?? "(default)"} / Model override: ${opts.model ?? "(default)"}`
            )
        );
    } else {
        lines.push(
            pc.cyan(
                `  - Provider/model: server-configured default (server.json → provider.${opts.action === "ask" ? "qa" : "summarize"}).`
            )
        );
    }

    lines.push(pc.yellow(`  - Cost: depends on the provider — subscription quota or pay-per-call API spend.`));

    for (const line of lines) {
        console.error(line);
    }

    if (opts.yes) {
        return true;
    }

    if (!isInteractive()) {
        console.error(pc.red("Refusing to call the LLM in non-interactive mode without --yes/-y."));
        return false;
    }

    const answer = await p.confirm({ message: "Proceed with the LLM call?", initialValue: false });
    if (p.isCancel(answer)) {
        return false;
    }

    return Boolean(answer);
}
