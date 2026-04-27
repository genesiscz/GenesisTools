import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { normaliseHandle, wrap } from "@app/youtube/commands/_shared/utils";
import type { VideoId } from "@app/youtube/lib/types";
import { formatDuration } from "@app/utils/format";
import { Command } from "commander";
import pc from "picocolors";

interface ListOpts {
    channel?: string;
    since?: string;
    limit: number;
    includeShorts?: boolean;
}

interface SearchHit {
    kind: "transcript" | "title" | "desc";
    videoId: VideoId;
    snippet: string;
    rank: number;
    lang?: string;
}

export function registerVideosCommand(program: Command): void {
    const cmd = program.command("videos").description("List, inspect, and search cached videos");

    cmd.command("list")
        .description("List cached videos")
        .option("--channel <handle>", "Filter by channel handle")
        .option("--since <date>", "Only videos uploaded on/after YYYY-MM-DD")
        .option("--limit <n>", "Max rows (default 30)", (value) => Number.parseInt(value, 10), 30)
        .option("--include-shorts", "Include Shorts")
        .addHelpText("after", "\nExamples:\n  $ tools youtube videos list --channel @mkbhd\n  $ tools youtube --json videos list --limit 100\n")
        .action(async (opts: ListOpts) => {
            const yt = await getYoutube();
            const rows = yt.videos.list({
                channel: opts.channel ? normaliseHandle(opts.channel) : undefined,
                since: opts.since,
                limit: opts.limit,
                includeShorts: opts.includeShorts,
            });
            const text = renderColumns({
                rows,
                emptyMessage: "No cached videos — try `tools youtube channels sync --all`.",
                schema: [
                    { header: "Uploaded", get: (video) => video.uploadDate ?? "—", minWidth: 11 },
                    { header: "Channel", get: (video) => video.channelHandle, maxWidth: 18 },
                    { header: "Duration", get: (video) => formatDuration((video.durationSec ?? 0) * 1000, "ms", "hms"), align: "right", minWidth: 9 },
                    { header: "Title", get: (video) => video.title, maxWidth: 50 },
                    { header: "ID", get: (video) => video.id, color: (value) => pc.dim(value) },
                ],
            });

            await renderOrEmit({ text, json: rows, flags: cmd.optsWithGlobals() });
        });

    cmd.command("show")
        .argument("<id>")
        .description("Show full metadata + transcript availability for a video")
        .addHelpText("after", "\nExamples:\n  $ tools youtube videos show dQw4w9WgXcQ\n  $ tools youtube --json videos show dQw4w9WgXcQ\n")
        .action(async (id: string) => {
            const yt = await getYoutube();
            const video = yt.videos.show(id as VideoId);

            if (!video) {
                console.error(pc.red(`Unknown video: ${id}`));
                process.exitCode = 1;
                return;
            }

            const transcript = yt.db.getTranscript(id as VideoId);
            const text = [
                pc.bold(video.title),
                pc.dim(`${video.channelHandle} · ${video.uploadDate ?? "—"} · ${formatDuration((video.durationSec ?? 0) * 1000, "ms", "hms")}`),
                "",
                wrap(video.description ?? "", 80),
                "",
                transcript ? pc.green(`Transcript (${transcript.lang}, ${transcript.source}, ${transcript.text.length} chars)`) : pc.dim("No transcript yet"),
                video.summaryShort ? `\n${pc.bold("Summary")}\n${wrap(video.summaryShort, 80)}` : "",
            ].join("\n");

            await renderOrEmit({ text, json: { video, transcript }, flags: cmd.optsWithGlobals() });
        });

    cmd.command("search")
        .argument("<query>")
        .description("Search transcripts, titles, and descriptions by keyword")
        .option("--in <fields>", "Comma-separated: transcript,title,desc (default: transcript)", (value) => value.split(",").map((part) => part.trim()).filter(Boolean), ["transcript"])
        .option("--channel <handle>", "Filter metadata search by channel handle")
        .option("--limit <n>", "Max hits", (value) => Number.parseInt(value, 10), 50)
        .addHelpText("after", "\nExamples:\n  $ tools youtube videos search iphone\n  $ tools youtube videos search iphone --in transcript,title --channel @mkbhd\n")
        .action(async (query: string, opts: { in: string[]; channel?: string; limit: number }) => {
            const yt = await getYoutube();
            const results: SearchHit[] = [];
            const lowered = query.toLowerCase();

            if (opts.in.includes("transcript")) {
                const hits = yt.videos.search(query, { limit: opts.limit });
                results.push(...hits.map((hit) => ({ kind: "transcript" as const, ...hit })));
            }

            if (opts.in.includes("title") || opts.in.includes("desc")) {
                const all = yt.videos.list({ channel: opts.channel ? normaliseHandle(opts.channel) : undefined, limit: 5_000, includeShorts: true, includeLive: true });
                for (const video of all) {
                    if (opts.in.includes("title") && video.title.toLowerCase().includes(lowered)) {
                        results.push({ kind: "title", videoId: video.id, snippet: video.title, rank: 0 });
                    }

                    if (opts.in.includes("desc") && video.description?.toLowerCase().includes(lowered)) {
                        results.push({ kind: "desc", videoId: video.id, snippet: video.description.slice(0, 160), rank: 0 });
                    }
                }
            }

            const limited = results.slice(0, opts.limit);
            const text = renderColumns({
                rows: limited,
                emptyMessage: "No video search hits.",
                schema: [
                    { header: "Kind", get: (row) => row.kind, minWidth: 10 },
                    { header: "Video", get: (row) => row.videoId, minWidth: 11 },
                    { header: "Snippet", get: (row) => row.snippet.replace(/\s+/g, " "), maxWidth: 90 },
                ],
            });

            await renderOrEmit({ text, json: limited, flags: cmd.optsWithGlobals() });
        });
}
