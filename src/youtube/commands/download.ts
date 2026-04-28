import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { resolveTargetKind } from "@app/youtube/commands/_shared/utils";
import type { JobStage, PipelineJob, VideoId } from "@app/youtube/lib/types";
import type { Command } from "commander";
import pc from "picocolors";

interface DownloadOpts {
    audio?: boolean;
    video?: boolean;
    quality: "720p" | "1080p" | "best";
    keep?: boolean;
}

export function registerDownloadCommand(program: Command): void {
    const cmd = program
        .command("download")
        .description("Download audio and/or video for a YouTube target, persisted to the cache")
        .argument("<target>", "Video ID, URL, or @handle")
        .option("--audio", "Download archived opus audio (default if neither flag is given)")
        .option("--video", "Download a video file too")
        .option("--quality <q>", "720p | 1080p | best (default: 720p)", "720p")
        .option("--keep", "Override the default video TTL — keeps file beyond auto-prune")
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube download dQw4w9WgXcQ --audio\n  $ tools youtube download dQw4w9WgXcQ --video --quality 1080p\n"
        )
        .action(async (target: string, opts: DownloadOpts) => {
            const yt = await getYoutube();
            const stages = downloadStages(opts);
            const job = yt.pipeline.enqueue({
                targetKind: resolveTargetKind(target),
                target,
                stages,
            });

            await yt.pipeline.start();
            if (opts.keep && resolveTargetKind(target) === "video") {
                yt.db.setVideoPinned(target as VideoId, true);

                if (!cmd.optsWithGlobals().silent) {
                    process.stderr.write(`--keep applied: ${target} pinned (cache prune will skip it).\n`);
                }
            }

            const final = await waitForJob(yt, job.id);
            await renderOrEmit({
                text: renderDownloadResult(final),
                json: final,
                flags: cmd.optsWithGlobals(),
            });
        });
}

function downloadStages(opts: DownloadOpts): JobStage[] {
    validateQuality(opts.quality);
    const includeAudio = opts.audio || !opts.video;
    const includeVideo = Boolean(opts.video);
    const stages: JobStage[] = ["metadata"];

    if (includeAudio || includeVideo) {
        stages.push("audio");
    }

    if (includeVideo) {
        stages.push("video" as JobStage);
    }

    return stages;
}

async function waitForJob(yt: Awaited<ReturnType<typeof getYoutube>>, jobId: number): Promise<PipelineJob> {
    const immediate = yt.pipeline.getJob(jobId);

    if (
        immediate &&
        (immediate.status === "completed" || immediate.status === "failed" || immediate.status === "cancelled")
    ) {
        return immediate;
    }

    return new Promise((resolve, reject) => {
        const cleanup: Array<() => void> = [];
        const timer = setInterval(() => {
            const job = yt.pipeline.getJob(jobId);

            if (!job) {
                return;
            }

            if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
                clearInterval(timer);
                for (const dispose of cleanup) {
                    dispose();
                }
                resolve(job);
            }
        }, 100);

        cleanup.push(
            yt.pipeline.on("job:completed", (event) => {
                if (event.job.id === jobId) {
                    clearInterval(timer);
                    for (const dispose of cleanup) {
                        dispose();
                    }
                    resolve(event.job);
                }
            }),
            yt.pipeline.on("job:failed", (event) => {
                if (event.job.id === jobId) {
                    clearInterval(timer);
                    for (const dispose of cleanup) {
                        dispose();
                    }
                    reject(new Error(event.error));
                }
            })
        );
    });
}

function renderDownloadResult(job: PipelineJob): string {
    return renderColumns({
        rows: [job],
        schema: [
            { header: "Job", get: (row) => row.id, align: "right", minWidth: 5 },
            { header: "Status", get: (row) => row.status, color: colorStatus },
            { header: "Target", get: (row) => row.target, maxWidth: 40 },
            { header: "Stages", get: (row) => row.stages.join(",") },
            { header: "Error", get: (row) => row.error ?? "" },
        ],
    });
}

function colorStatus(value: string): string {
    if (value.trim() === "completed") {
        return pc.green(value);
    }

    if (value.trim() === "failed") {
        return pc.red(value);
    }

    return value;
}

function validateQuality(value: string): asserts value is DownloadOpts["quality"] {
    if (value !== "720p" && value !== "1080p" && value !== "best") {
        throw new Error(`Unsupported quality: ${value}`);
    }
}
