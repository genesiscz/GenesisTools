import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { statusIcon } from "@app/youtube/commands/_shared/status-icon";
import { splitTargets } from "@app/youtube/commands/_shared/utils";
import { type JobActor, parseJobStatus, type QueueWatchEvent, toJobStages } from "@app/youtube/lib/queue";
import { withConsoleContext } from "@app/youtube/lib/service-user";
import type { PipelineJob } from "@app/youtube/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * Thin controller over `QueueService`. Every verb here is one facade call plus
 * rendering: the queue's own module owns normalisation, redaction and the watch
 * diffing, so a CLI and the HTTP routes cannot drift into two behaviours.
 */

/**
 * This door's reach over the queue.
 *
 * `tools youtube` runs on the operator's own machine, against their own database,
 * with no auth gate in front of it — `resolveJobActor` (server/auth.ts) names this
 * command as an operator for exactly that reason, and `download` / `pipeline`
 * already wait on jobs as one. Scoping the CLI to the console service account
 * instead would hide every job the web UI's users enqueued from the person
 * administering the queue, which is the opposite of what `queue list` is for.
 *
 * Note this is a READ scope. New jobs are still attributed to the console user
 * (`withConsoleContext` below), so operator reach never makes CLI work unowned.
 */
const CLI_ACTOR: JobActor = { kind: "operator" };

interface AddOpts {
    stages: string[];
    priority?: number;
    force?: boolean;
    watch?: boolean;
    json?: boolean;
}

interface ListOpts {
    status?: string;
    target?: string;
    limit: string;
    json?: boolean;
}

interface ShowOpts {
    activity?: boolean;
    json?: boolean;
}

interface WatchOpts {
    jsonl?: boolean;
    timeout?: string;
    noChildren?: boolean;
}

function jobRows(jobs: PipelineJob[]): string {
    return renderColumns({
        rows: jobs,
        emptyMessage: "(no jobs)",
        schema: [
            { header: "ID", get: (job) => String(job.id) },
            { header: "", get: (job) => statusIcon(job.status) },
            { header: "STATUS", get: (job) => job.status },
            { header: "TARGET", get: (job) => job.target },
            { header: "STAGE", get: (job) => job.currentStage ?? pc.dim("—") },
            { header: "CREATED", get: (job) => job.createdAt },
        ],
    });
}

/** One line per event, matching the repo's `--jsonl` idiom (one JSON object per line). */
function watchLine(event: QueueWatchEvent, jsonl: boolean): string {
    if (jsonl) {
        return SafeJSON.stringify(event, { jsonl: true });
    }

    switch (event.type) {
        case "job:seen":
            return `${statusIcon(event.job.status)} ${event.job.id} ${pc.dim("seen")} ${event.job.target}`;
        case "job:status":
            return `${statusIcon(event.job.status)} ${event.jobId} ${event.from} → ${event.to}`;
        case "job:stage":
            return `${pc.cyan("▶")} ${event.jobId} stage ${event.from ?? "—"} → ${event.to ?? "—"}`;
        case "job:progress":
            return `${pc.dim("·")} ${event.jobId} ${Math.round(event.progress * 100)}% ${event.message ?? ""}`.trimEnd();
        case "job:activity":
            return `${pc.dim("·")} ${event.jobId} ${event.activity.kind}`;
        case "watch:done":
            return pc.dim(`done (${event.reason}) — ${event.jobIds.length} job(s)`);
    }
}

export function registerQueueCommand(program: Command): void {
    const queue = program.command("queue").description("Enqueue and inspect pipeline jobs");

    queue
        .command("add <targets...>")
        .description("Enqueue one job per target")
        .option(
            "--stages <list>",
            "Comma-separated stage list",
            (value) =>
                value
                    .split(",")
                    .map((part) => part.trim())
                    .filter(Boolean),
            ["metadata", "captions", "transcribe", "summarize"]
        )
        .option("--priority <n>", "Higher runs first", (value) => Number.parseInt(value, 10))
        .option("--force", "Enqueue even when an identical job is already active")
        .option("--watch", "Follow the enqueued jobs until they finish")
        .option("--json", "Machine-readable output")
        .action(async (targets: string[], opts: AddOpts, cmd: Command) => {
            const yt = await getYoutube();
            const stages = toJobStages(opts.stages);

            // Attributed to the console service user, so CLI-triggered work lands
            // in `job_activity` / `ai_calls` alongside HTTP-triggered work.
            const results = await withConsoleContext(yt.db, async (user) =>
                splitTargets(targets).map((target) =>
                    yt.queue.enqueue({ target, stages, userId: user.id, priority: opts.priority, force: opts.force })
                )
            );

            const jobs = results.map((result) => result.job).filter((job): job is PipelineJob => job !== null);

            await renderOrEmit({ text: jobRows(jobs), json: results, flags: cmd.optsWithGlobals() });

            if (opts.watch && jobs.length > 0) {
                for await (const event of yt.queue.watch({ actor: CLI_ACTOR, jobIds: jobs.map((job) => job.id) })) {
                    out.println(watchLine(event, false));
                }
            }
        });

    queue
        .command("list")
        .description("List jobs, newest first")
        .option("--status <status>", "pending | running | completed | failed | cancelled")
        .option("--target <target>", "Filter by target")
        .option("--limit <n>", "Max rows", "20")
        .option("--json", "Machine-readable output")
        .action(async (opts: ListOpts, cmd: Command) => {
            const yt = await getYoutube();
            const status = parseJobStatus(opts.status ?? null);

            if (opts.status && !status) {
                out.error(`Unknown status "${opts.status}".`);
                process.exitCode = 1;
                return;
            }

            const jobs = yt.queue.list({
                ...(status ? { status } : {}),
                ...(opts.target ? { target: opts.target } : {}),
                limit: Number.parseInt(opts.limit, 10),
                redact: true,
                actor: CLI_ACTOR,
            });

            await renderOrEmit({ text: jobRows(jobs), json: jobs, flags: cmd.optsWithGlobals() });
        });

    queue
        .command("show <id>")
        .description("Show one job, optionally with its activity rows")
        .option("--activity", "Include the job_activity rows")
        .option("--json", "Machine-readable output")
        .action(async (id: string, opts: ShowOpts, cmd: Command) => {
            const yt = await getYoutube();
            const jobId = Number.parseInt(id, 10);
            const found = yt.queue.get(jobId, { redact: true, actor: CLI_ACTOR });

            if (!found) {
                out.error(`Job ${jobId} not found.`);
                process.exitCode = 1;
                return;
            }

            const activity = opts.activity ? (yt.queue.activity(jobId, CLI_ACTOR) ?? []) : undefined;
            const lines = [
                jobRows([found.job]),
                found.queuePosition === null ? "" : pc.dim(`queue position: ${found.queuePosition}`),
                ...(activity
                    ? activity.map((row) => `${pc.dim("·")} ${row.kind} ${row.provider ?? ""}`.trimEnd())
                    : []),
            ].filter(Boolean);

            await renderOrEmit({
                text: lines.join("\n"),
                json: { ...found, ...(activity ? { activity } : {}) },
                flags: cmd.optsWithGlobals(),
            });
        });

    queue
        .command("watch [ids...]")
        .description("Stream job events until they finish; no ids watches everything active")
        .option("--jsonl", "One JSON object per line")
        .option("--timeout <sec>", "Give up after N seconds")
        .option("--no-children", "Do not follow jobs spawned by the watched ones")
        .action(async (ids: string[], opts: WatchOpts) => {
            const yt = await getYoutube();
            const jobIds = ids.map((id) => Number.parseInt(id, 10)).filter((id) => Number.isFinite(id));

            for await (const event of yt.queue.watch({
                actor: CLI_ACTOR,
                ...(jobIds.length > 0 ? { jobIds } : {}),
                followChildren: opts.noChildren !== true,
                ...(opts.timeout ? { timeoutMs: Number.parseInt(opts.timeout, 10) * 1000 } : {}),
            })) {
                // stdout, because `--jsonl` output is meant to be piped.
                process.stdout.write(`${watchLine(event, opts.jsonl === true)}\n`);
            }
        });

    queue
        .command("cancel <id>")
        .description("Cancel a pending or running job")
        .action(async (id: string) => {
            const yt = await getYoutube();
            const job = yt.queue.cancel(Number.parseInt(id, 10), CLI_ACTOR);

            if (!job) {
                out.error(`Job ${id} not found or already finished.`);
                process.exitCode = 1;
                return;
            }

            out.println(`${statusIcon(job.status)} ${job.id} ${job.status}`);
        });

    queue
        .command("stats")
        .description("Queue depth, per stage")
        .option("--json", "Machine-readable output")
        .action(async (_opts: unknown, cmd: Command) => {
            const yt = await getYoutube();
            const stats = yt.queue.stats(CLI_ACTOR);

            const text = [
                `queued: ${stats.queued}   running: ${stats.running}`,
                stats.oldestQueuedAgeSec === null ? "" : pc.dim(`oldest queued: ${stats.oldestQueuedAgeSec}s`),
                renderColumns({
                    rows: Object.entries(stats.perStage),
                    emptyMessage: "(nothing queued)",
                    schema: [
                        { header: "STAGE", get: ([stage]) => stage },
                        { header: "QUEUED", get: ([, counts]) => String(counts.queued) },
                        { header: "RUNNING", get: ([, counts]) => String(counts.running) },
                    ],
                }),
            ]
                .filter(Boolean)
                .join("\n");

            await renderOrEmit({ text, json: stats, flags: cmd.optsWithGlobals() });
        });
}
