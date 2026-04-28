import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { statusIcon } from "@app/youtube/commands/_shared/status-icon";
import { resolveTargetKind, splitTargets, toJobStages } from "@app/youtube/commands/_shared/utils";
import type { PipelineJob } from "@app/youtube/lib/types";
import type { Command } from "commander";

interface PipelineOpts {
    stages: string[];
    concurrency?: number;
    watch?: boolean;
}

export function registerPipelineCommand(program: Command): void {
    const cmd = program
        .command("pipeline")
        .description("Run a multi-stage pipeline against one or more targets")
        .argument("<targets...>", "Video IDs, URLs, or @handles")
        .option(
            "--stages <list>",
            "Comma-separated: metadata,captions,audio,video,transcribe,summarize",
            (value) =>
                value
                    .split(",")
                    .map((part) => part.trim())
                    .filter(Boolean),
            ["metadata", "captions", "transcribe", "summarize"]
        )
        .option("--concurrency <n>", "Override every per-stage concurrency cap to this value", (value) =>
            Number.parseInt(value, 10)
        )
        .option("--watch", "Stream live progress; default is to print final summary only")
        .addHelpText("after", buildPipelineExamples())
        .action(async (targets: string[], opts: PipelineOpts) => {
            const yt = await getYoutube();
            const stages = toJobStages(opts.stages);

            if (opts.concurrency !== undefined) {
                yt.pipeline.setGlobalConcurrencyOverride(opts.concurrency);
            }

            const jobs = splitTargets(targets).map((target) =>
                yt.pipeline.enqueue({
                    targetKind: resolveTargetKind(target),
                    target,
                    stages,
                })
            );
            await yt.pipeline.start();

            const finalRows = opts.watch
                ? await Promise.all(jobs.map((job) => streamJobToCompletion(yt, job.id, !cmd.optsWithGlobals().silent)))
                : await Promise.all(jobs.map((job) => waitForJob(yt, job.id)));

            await renderOrEmit({
                text: renderPipelineRows(finalRows),
                json: finalRows,
                flags: cmd.optsWithGlobals(),
            });
        });
}

export async function waitForJob(yt: Awaited<ReturnType<typeof getYoutube>>, jobId: number): Promise<PipelineJob> {
    const immediate = yt.pipeline.getJob(jobId);

    if (immediate && isFinal(immediate)) {
        return immediate;
    }

    return new Promise((resolve, reject) => {
        const cleanup: Array<() => void> = [];
        const timer = setInterval(() => {
            const job = yt.pipeline.getJob(jobId);

            if (job && isFinal(job)) {
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

export async function streamJobToCompletion(
    yt: Awaited<ReturnType<typeof getYoutube>>,
    jobId: number,
    shouldPrint: boolean
): Promise<PipelineJob> {
    const dispose = yt.pipeline.on("stage:progress", (event) => {
        if (!shouldPrint || event.jobId !== jobId) {
            return;
        }

        const pct = Math.round(event.progress * 100);
        process.stderr.write(`job ${jobId} ${event.stage} ${pct}% ${event.message ?? ""}\n`);
    });

    try {
        return await waitForJob(yt, jobId);
    } finally {
        dispose();
    }
}

function renderPipelineRows(rows: PipelineJob[]): string {
    return renderColumns({
        rows,
        schema: [
            { header: "Job", get: (job) => job.id, align: "right", minWidth: 5 },
            { header: "Status", get: (job) => `${statusIcon(job.status)} ${job.status}` },
            { header: "Target", get: (job) => job.target, maxWidth: 30 },
            { header: "Stages", get: (job) => job.stages.join(",") },
            { header: "Error", get: (job) => job.error ?? "" },
        ],
    });
}

function isFinal(job: PipelineJob): boolean {
    return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}

function buildPipelineExamples(): string {
    return "\nExamples:\n  $ tools youtube pipeline @mkbhd --stages discover,metadata,captions\n  $ tools youtube pipeline dQw4w9WgXcQ --stages metadata,captions,summarize --concurrency 4 --watch\n";
}
