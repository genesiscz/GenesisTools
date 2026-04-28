import { formatDuration } from "@app/utils/format";
import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { normaliseHandle, wrap } from "@app/youtube/commands/_shared/utils";
import type { ChannelHandle, VideoId, VideoSearchField } from "@app/youtube/lib/types";
import type { Command } from "commander";
import pc from "picocolors";

interface ListOpts {
    channel?: string;
    since?: string;
    limit: number;
    includeShorts?: boolean;
}

interface SearchHit {
    kind: "transcript" | "title" | "description" | "tags";
    videoId: VideoId;
    snippet: string;
    rank: number;
    lang?: string;
}

const VALID_SEARCH_FIELDS = new Set<string>(["transcript", "title", "description", "desc", "tags"]);

export function registerVideosCommand(program: Command): void {
    const cmd = program.command("videos").description("List, inspect, and search cached videos");

    cmd.command("list")
        .description("List cached videos")
        .option("--channel <handle>", "Filter by channel handle")
        .option("--since <date>", "Only videos uploaded on/after YYYY-MM-DD")
        .option("--limit <n>", "Max rows (default 30)", (value) => Number.parseInt(value, 10), 30)
        .option("--include-shorts", "Include Shorts")
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube videos list --channel @mkbhd\n  $ tools youtube --json videos list --limit 100\n"
        )
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
                    {
                        header: "Duration",
                        get: (video) => formatDuration((video.durationSec ?? 0) * 1000, "ms", "hms"),
                        align: "right",
                        minWidth: 9,
                    },
                    { header: "Title", get: (video) => video.title, maxWidth: 50 },
                    { header: "ID", get: (video) => video.id, color: (value) => pc.dim(value) },
                ],
            });

            await renderOrEmit({ text, json: rows, flags: cmd.optsWithGlobals() });
        });

    cmd.command("show")
        .argument("<id>")
        .description("Show full metadata + transcript availability for a video")
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube videos show dQw4w9WgXcQ\n  $ tools youtube --json videos show dQw4w9WgXcQ\n"
        )
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
                pc.dim(
                    `${video.channelHandle} · ${video.uploadDate ?? "—"} · ${formatDuration((video.durationSec ?? 0) * 1000, "ms", "hms")}`
                ),
                "",
                wrap(video.description ?? "", 80),
                "",
                transcript
                    ? pc.green(`Transcript (${transcript.lang}, ${transcript.source}, ${transcript.text.length} chars)`)
                    : pc.dim("No transcript yet"),
                video.summaryShort ? `\n${pc.bold("Summary")}\n${wrap(video.summaryShort, 80)}` : "",
            ].join("\n");

            await renderOrEmit({ text, json: { video, transcript }, flags: cmd.optsWithGlobals() });
        });

    cmd.command("search")
        .argument("<query>")
        .description("Search transcripts, titles, descriptions, and tags by keyword (server-side SQL)")
        .option(
            "--in <fields>",
            "Comma-separated: transcript,title,description,tags (default: transcript)",
            (value) =>
                value
                    .split(",")
                    .map((part) => part.trim())
                    .filter(Boolean),
            ["transcript"]
        )
        .option("--channel <handle>", "Filter metadata search by channel handle")
        .option("--limit <n>", "Max hits", (value) => Number.parseInt(value, 10), 50)
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube videos search iphone\n  $ tools youtube videos search iphone --in title,description --channel @mkbhd\n  $ tools youtube videos search agentic --in tags\n"
        )
        .action(async (query: string, opts: { in: string[]; channel?: string; limit: number }) => {
            const yt = await getYoutube();
            const fields = normaliseSearchFields(opts.in);
            const results: SearchHit[] = [];

            if (fields.includes("transcript")) {
                const hits = yt.videos.search(query, { limit: opts.limit });
                results.push(...hits.map((hit) => ({ kind: "transcript" as const, ...hit })));
            }

            const metadataFields = fields.filter((f): f is VideoSearchField => f !== "transcript");

            if (metadataFields.length > 0) {
                const channel = opts.channel ? normaliseHandle(opts.channel) : undefined;
                const hits = yt.videos.searchMetadata(query, {
                    fields: metadataFields,
                    channel: channel as ChannelHandle | undefined,
                    limit: opts.limit,
                    includeShorts: true,
                    includeLive: true,
                });

                for (const hit of hits) {
                    results.push({ kind: hit.field, videoId: hit.videoId, snippet: hit.snippet, rank: 0 });
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

    cmd.command("sync-dates")
        .description("Backfill upload_date for cached videos that are missing one (queries yt-dlp once per row)")
        .option("--channel <handle>", "Limit to a single channel")
        .option("--limit <n>", "Max rows to scan in one run (default 200)", (value) => Number.parseInt(value, 10), 200)
        .option("--concurrency <n>", "Parallel yt-dlp lookups (default 4)", (value) => Number.parseInt(value, 10), 4)
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube videos sync-dates --channel @mkbhd --limit 50\n  $ tools youtube videos sync-dates --concurrency 6\n"
        )
        .action(async (opts: { channel?: string; limit: number; concurrency: number }) => {
            const yt = await getYoutube();
            const channel = opts.channel ? normaliseHandle(opts.channel) : undefined;
            const flags = cmd.optsWithGlobals();
            const isSilent = Boolean(flags.silent || flags.json);

            const result = await yt.videos.syncDates({
                channel,
                limit: opts.limit,
                concurrency: opts.concurrency,
                onProgress: (info) => {
                    if (!isSilent) {
                        const status = info.uploadDate ? pc.green(info.uploadDate) : pc.dim("—");
                        process.stderr.write(`\r[${info.index}/${info.total}] ${info.videoId}  ${status}     `);
                    }
                },
            });

            if (!isSilent) {
                process.stderr.write("\n");
            }

            const lines = [
                `Scanned: ${result.scanned}`,
                `Updated: ${pc.green(String(result.updated))}`,
                `Failed:  ${result.failed.length > 0 ? pc.red(String(result.failed.length)) : "0"}`,
            ];

            if (result.failed.length > 0) {
                lines.push("", pc.bold("Failures:"));
                for (const failure of result.failed.slice(0, 10)) {
                    lines.push(`  ${failure.videoId}  ${pc.red(failure.error)}`);
                }

                if (result.failed.length > 10) {
                    lines.push(`  …and ${result.failed.length - 10} more`);
                }
            }

            await renderOrEmit({ text: lines.join("\n"), json: result, flags });
        });
}

function normaliseSearchFields(input: string[]): Array<"transcript" | VideoSearchField> {
    const out: Array<"transcript" | VideoSearchField> = [];

    for (const value of input) {
        const lower = value.toLowerCase();

        if (!VALID_SEARCH_FIELDS.has(lower)) {
            throw new Error(`unknown --in field: ${value} (allowed: transcript, title, description, tags)`);
        }

        const normalised = lower === "desc" ? "description" : lower;

        if (!out.includes(normalised as "transcript" | VideoSearchField)) {
            out.push(normalised as "transcript" | VideoSearchField);
        }
    }

    return out;
}
