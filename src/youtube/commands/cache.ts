import { existsSync, statSync, unlinkSync } from "node:fs";
import { formatBytes } from "@app/utils/format";
import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { confirmDestructive } from "@app/youtube/commands/_shared/confirm";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import type { Command } from "commander";
import pc from "picocolors";

interface ClearOpts {
    audio?: boolean;
    video?: boolean;
    thumbs?: boolean;
    all?: boolean;
    yes?: boolean;
}

interface CacheStats {
    channels: number;
    videos: number;
    transcripts: number;
    jobs: Array<{ status: string; count: number }>;
    audioBytes: number;
    videoBytes: number;
    thumbBytes: number;
}

interface ClearResult {
    deletedCount: number;
    freedBytes: number;
}

export function registerCacheCommand(program: Command): void {
    const cmd = program.command("cache").description("Inspect and prune the YouTube cache");

    cmd.command("stats")
        .description("Show row counts and binary cache footprint")
        .addHelpText("after", "\nExamples:\n  $ tools youtube cache stats\n  $ tools youtube --json cache stats\n")
        .action(async () => {
            const yt = await getYoutube();
            const stats = cacheStats(yt);
            const text = [
                pc.bold("Cache stats"),
                `  channels:    ${stats.channels}`,
                `  videos:      ${stats.videos}`,
                `  transcripts: ${stats.transcripts}`,
                `  audio cache: ${formatBytes(stats.audioBytes)}`,
                `  video cache: ${formatBytes(stats.videoBytes)}`,
                `  thumb cache: ${formatBytes(stats.thumbBytes)}`,
                "",
                renderColumns({
                    rows: stats.jobs,
                    emptyMessage: "No jobs yet.",
                    schema: [
                        { header: "Status", get: (row) => row.status, minWidth: 12 },
                        { header: "Jobs", get: (row) => row.count, align: "right", minWidth: 6 },
                    ],
                }),
            ].join("\n");

            await renderOrEmit({ text, json: stats, flags: cmd.optsWithGlobals() });
        });

    cmd.command("prune")
        .description("Delete expired binary caches based on configured TTLs")
        .option("--dry-run", "Show what would be deleted without deleting")
        .addHelpText("after", "\nExamples:\n  $ tools youtube cache prune\n  $ tools youtube cache prune --dry-run\n")
        .action(async (opts: { dryRun?: boolean }) => {
            const yt = await getYoutube();
            const ttlConfig = await yt.config.get("ttls");
            const ttl = {
                audioOlderThanDays: ttlDays(ttlConfig.audio),
                videoOlderThanDays: ttlDays(ttlConfig.video),
                thumbOlderThanDays: ttlDays(ttlConfig.thumb),
            };
            const result = opts.dryRun ? { audio: 0, video: 0, thumb: 0 } : await yt.db.pruneExpiredBinaries(ttl);
            const suffix = opts.dryRun ? " (dry run)" : "";

            await renderOrEmit({
                text: `Pruned ${result.audio} audio · ${result.video} video · ${result.thumb} thumb files${suffix}`,
                json: { ...result, dryRun: Boolean(opts.dryRun) },
                flags: cmd.optsWithGlobals(),
            });
        });

    cmd.command("clear")
        .description("Delete cached binaries")
        .option("--audio", "Delete all cached audio files")
        .option("--video", "Delete all cached video files")
        .option("--thumbs", "Delete all cached thumbnails")
        .option("--all", "Delete all of the above")
        .option("--yes", "Skip confirmation")
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube cache clear --thumbs --yes\n  $ tools youtube cache clear --all --yes\n"
        )
        .action(async (opts: ClearOpts) => {
            const flags = opts.all ? { audio: true, video: true, thumbs: true } : opts;

            if (!flags.audio && !flags.video && !flags.thumbs) {
                console.error(pc.red("Specify --audio, --video, --thumbs, or --all"));
                process.exitCode = 1;
                return;
            }

            const ok =
                opts.yes ||
                (await confirmDestructive({
                    message: `clear cached binaries (${selectedKinds(flags).join(", ")})`,
                    toolName: "tools youtube cache clear",
                    assumeYesFlag: "--yes",
                }));

            if (!ok) {
                return;
            }

            const result = await clearBinaries(await getYoutube(), flags);

            await renderOrEmit({
                text: `Deleted ${result.deletedCount} file(s), freed ${formatBytes(result.freedBytes)}`,
                json: result,
                flags: cmd.optsWithGlobals(),
            });
        });
}

function cacheStats(yt: Awaited<ReturnType<typeof getYoutube>>): CacheStats {
    const channels = yt.db.listChannels().length;
    const videos = yt.videos.list({ limit: 1_000_000, includeShorts: true, includeLive: true });
    const jobs = yt.pipeline.listJobs({ limit: 1_000_000 }).reduce<Map<string, number>>((counts, job) => {
        counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
        return counts;
    }, new Map());
    const transcripts = videos.reduce((count, video) => count + yt.db.listTranscripts(video.id).length, 0);

    return {
        channels,
        videos: videos.length,
        transcripts,
        jobs: [...jobs.entries()].map(([status, count]) => ({ status, count })),
        audioBytes: sum(videos.map((video) => video.audioSizeBytes)),
        videoBytes: sum(videos.map((video) => video.videoSizeBytes)),
        thumbBytes: 0,
    };
}

async function clearBinaries(
    yt: Awaited<ReturnType<typeof getYoutube>>,
    flags: Pick<ClearOpts, "audio" | "video" | "thumbs">
): Promise<ClearResult> {
    let deletedCount = 0;
    let freedBytes = 0;

    for (const video of yt.videos.list({ limit: 1_000_000, includeShorts: true, includeLive: true })) {
        if (flags.audio && video.audioPath) {
            freedBytes += deletePath(video.audioPath, video.audioSizeBytes);
            yt.db.setVideoBinaryPath(video.id, "audio", null);
            deletedCount++;
        }

        if (flags.video && video.videoPath) {
            freedBytes += deletePath(video.videoPath, video.videoSizeBytes);
            yt.db.setVideoBinaryPath(video.id, "video", null);
            deletedCount++;
        }

        if (flags.thumbs && video.thumbPath) {
            freedBytes += deletePath(video.thumbPath, null);
            yt.db.setVideoBinaryPath(video.id, "thumb", null);
            deletedCount++;
        }
    }

    return { deletedCount, freedBytes };
}

function selectedKinds(flags: Pick<ClearOpts, "audio" | "video" | "thumbs">): string[] {
    return [flags.audio ? "audio" : null, flags.video ? "video" : null, flags.thumbs ? "thumbs" : null].filter(
        (value): value is string => value !== null
    );
}

function ttlDays(raw: string): number | undefined {
    const match = raw.match(/^(\d+)\s+days?$/);
    return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

function deletePath(path: string, knownBytes: number | null): number {
    const bytes = knownBytes ?? (existsSync(path) ? statSync(path).size : 0);

    if (existsSync(path)) {
        unlinkSync(path);
    }

    return bytes;
}

function sum(values: Array<number | null>): number {
    return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
