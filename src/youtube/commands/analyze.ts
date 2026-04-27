import { formatSummary, resolveTargetsToVideoIds } from "@app/youtube/commands/_shared/utils";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { loadAskProviderChoice } from "@app/youtube/commands/_shared/ask-provider";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import type { TimestampedSummaryEntry, VideoId } from "@app/youtube/lib/types";
import { Command } from "commander";
import pc from "picocolors";

interface AnalyzeOpts {
    summary?: boolean;
    timestamped?: boolean;
    ask?: string;
    topK: number;
    stream?: boolean;
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
        .addHelpText("after", buildAnalyzeExamples())
        .action(async (targets: string[], opts: AnalyzeOpts) => {
            if (opts.ask && (opts.summary || opts.timestamped)) {
                console.error(pc.red("--ask is mutually exclusive with --summary/--timestamped"));
                process.exitCode = 1;
                return;
            }

            const yt = await getYoutube();
            const ids = await resolveTargetsToVideoIds(yt, targets);

            if (opts.ask) {
                for (const id of ids) {
                    await yt.qa.index({ videoId: id });
                }

                const result = await yt.qa.ask({
                    videoIds: ids,
                    question: opts.ask,
                    topK: opts.topK,
                    streaming: opts.stream,
                    providerChoice: await loadAskProviderChoice(),
                    streamTarget: opts.stream ? process.stdout : undefined,
                });
                const citations = result.citations.map((citation) => `${citation.videoId}#${citation.chunkIdx}`).join(", ");

                await renderOrEmit({
                    text: opts.stream ? "" : `${result.answer}\n\n${pc.dim("Citations:")} ${citations}`,
                    json: result,
                    flags: cmd.optsWithGlobals(),
                });
                return;
            }

            const mode = opts.timestamped ? "timestamped" : "short";
            const rows: SummaryRow[] = [];

            for (const id of ids) {
                rows.push({ videoId: id, result: await yt.summary.summarize({ videoId: id, mode }) });
            }

            await renderOrEmit({
                text: rows.map((row) => formatSummary(row.videoId, row.result, mode)).join("\n\n"),
                json: rows,
                flags: cmd.optsWithGlobals(),
            });
        });
}

function buildAnalyzeExamples(): string {
    return "\nExamples:\n  $ tools youtube analyze dQw4w9WgXcQ --summary\n  $ tools youtube analyze dQw4w9WgXcQ --timestamped\n  $ tools youtube analyze dQw4w9WgXcQ otherVideo123 --ask \"what are the key claims?\"\n";
}
