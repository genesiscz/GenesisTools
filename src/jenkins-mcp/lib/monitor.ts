import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { AxiosInstance } from "axios";
import { type ErrorBlock, extractErrors } from "./errors";
import { formatDuration, stageNotifyBody, stageNotifyStatus, statusBody } from "./format";
import { fetchLog, getBuildState } from "./log";
import type { MonitorNotifier } from "./notify";
import { getStages, type PipelineSnapshot, type RunStatus, type Stage, type StageStatus } from "./pipeline";
import { buildUrl } from "./url";

export type MonitorEvent =
    | { event: "start"; ts: string; jobPath: string; build: string; url: string }
    | {
          event: "snapshot";
          ts: string;
          stages: Array<{
              id: string;
              name: string;
              status: StageStatus;
              durationMillis?: number;
              path?: string[];
              context?: string;
              label?: string;
          }>;
      }
    | {
          event: "stage";
          ts: string;
          id: string;
          name: string;
          status: StageStatus;
          durationMillis?: number;
          path?: string[];
          context?: string;
          label?: string;
          url: string;
      }
    | {
          event: "branch";
          ts: string;
          stage: string;
          stageId: string;
          stageLabel?: string;
          id: string;
          name: string;
          status: StageStatus;
          durationMillis?: number;
          path?: string[];
          context?: string;
          url: string;
      }
    | {
          event: "error";
          ts: string;
          stage: string;
          stageId: string;
          line: number;
          matched: string;
          window: string[];
      }
    | { event: "run"; ts: string; status: RunStatus }
    | { event: "end"; ts: string; result: RunStatus; durationMillis: number; via?: "wfapi" | "api-json" };

/** Prefer enriched label ("fee-web · Tests") over bare stage name. */
function stageLabel(stage: Stage): string {
    return stage.label ?? stage.name;
}

export interface MonitorOpts {
    client: AxiosInstance;
    jobPath: string;
    build: string;
    baseUrl: string;
    timeoutMs: number;
    pollMs: number;
    notifier?: MonitorNotifier;
    out: (line: string) => void;
}

export interface MonitorResult {
    result: RunStatus;
    durationMs: number;
    timedOut: boolean;
}

/** Stages that belong in the historical first-poll snapshot (actually finished work). */
const SNAPSHOT_COMPLETED: StageStatus[] = ["SUCCESS", "FAILED", "UNSTABLE", "ABORTED"];

// wfapi's run-level status can stay IN_PROGRESS for minutes after every visible
// flow node finished (common with multibranch dispatcher pipelines that hold the
// parent run open while downstream-build bookkeeping settles). After this many
// consecutive polls with no stage/branch delta we cross-check `/api/json?tree=building,result`
// which sees the build's authoritative state.
const STALE_POLLS_BEFORE_API_FALLBACK = 3;

/** Statuses that should be tracked for dedup but never emitted as stage/branch events. */
function isSilentStatus(status: StageStatus): boolean {
    return status === "NOT_EXECUTED";
}

function isTerminalRun(status: RunStatus): boolean {
    return status !== "IN_PROGRESS" && status !== "PAUSED_PENDING_INPUT" && status !== "QUEUED";
}

function mapJenkinsResult(result: string): RunStatus {
    switch (result) {
        case "SUCCESS":
            return "SUCCESS";
        case "FAILURE":
            return "FAILED";
        case "ABORTED":
            return "ABORTED";
        case "UNSTABLE":
            return "UNSTABLE";
        case "NOT_BUILT":
            return "NOT_EXECUTED";
        default:
            logger.debug(`[mapJenkinsResult] unknown Jenkins result "${result}" — treating as FAILED`);
            return "FAILED";
    }
}

export async function runMonitor(opts: MonitorOpts): Promise<MonitorResult> {
    const { client, jobPath, build, baseUrl, timeoutMs, pollMs, notifier, out } = opts;
    const group = `jenkins-${jobPath.replace(/\//g, "_")}-${build}`;
    const baseRef = { jobPath, buildNumber: build };
    const buildHref = buildUrl(baseUrl, baseRef);
    const titleBase = `${jobPath.split("/").pop()} #${build}`;
    const ctx: NotifyContext = { notifier, group, titleBase };

    emit(out, { event: "start", ts: new Date().toISOString(), jobPath, build, url: buildHref });

    const seenStages = new Map<string, StageStatus>();
    const seenBranches = new Map<string, StageStatus>();
    const reportedErrors = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    let lastRunStatus: RunStatus | null = null;
    let pollsWithoutDelta = 0;

    while (Date.now() < deadline) {
        let snap: PipelineSnapshot;

        try {
            snap = await getStages(client, jobPath, build, { expand: true });
        } catch (error) {
            logger.debug(`Snapshot unavailable: ${error instanceof Error ? error.message : error}`);
            await sleep(pollMs);
            continue;
        }

        const isFirstPoll = seenStages.size === 0;

        if (isFirstPoll) {
            seedSnapshotState(snap, seenStages, seenBranches, out);
        }

        let stageDelta = false;

        for (const stage of snap.stages) {
            const lastStage = seenStages.get(stage.id);
            const stageUrl = buildUrl(baseUrl, { ...baseRef, nodeId: stage.id });

            // Emit only on (id, status) transitions. Duration-only changes (e.g.
            // growing elapsed on IN_PROGRESS) are ignored — that was a spam vector
            // when negative durations jittered every poll.
            if (lastStage !== stage.status) {
                // Count real status moves toward "not stale"; silent bookkeeping
                // for NOT_EXECUTED still updates the map so we don't re-process.
                if (!isSilentStatus(stage.status) || (lastStage !== undefined && !isSilentStatus(lastStage))) {
                    stageDelta = true;
                }

                seenStages.set(stage.id, stage.status);

                if (!isSilentStatus(stage.status)) {
                    emit(out, {
                        event: "stage",
                        ts: new Date().toISOString(),
                        id: stage.id,
                        name: stage.name,
                        status: stage.status,
                        durationMillis: stage.durationMillis,
                        path: stage.path,
                        context: stage.context,
                        label: stageLabel(stage),
                        url: stageUrl,
                    });

                    if (!isFirstPoll && stage.status !== "IN_PROGRESS") {
                        const isDispatch = isMultibranchDispatch(stage);
                        const fields = stageNotifyFields(stage);
                        const subtitle = isDispatch ? `${fields.subtitle} · orchestration` : fields.subtitle;
                        notifyTransition(ctx, {
                            title: fields.titleSuffix ? `${ctx.titleBase} · ${fields.titleSuffix}` : ctx.titleBase,
                            subtitle,
                            body: fields.body,
                            sound: stage.status === "FAILED" ? "Basso" : undefined,
                            openUrl: stageUrl,
                        });
                    }

                    if (stage.status === "FAILED" && !reportedErrors.has(stage.id)) {
                        reportedErrors.add(stage.id);
                        await emitErrorsForStage(opts, stage);
                    }
                }
            }

            for (const branch of stage.stageFlowNodes ?? []) {
                const key = `${stage.id}.${branch.id}`;
                const lastBranch = seenBranches.get(key);

                if (lastBranch === branch.status) {
                    continue;
                }

                if (!isSilentStatus(branch.status) || (lastBranch !== undefined && !isSilentStatus(lastBranch))) {
                    stageDelta = true;
                }

                seenBranches.set(key, branch.status);

                if (isSilentStatus(branch.status)) {
                    continue;
                }

                const branchUrl = buildUrl(baseUrl, { ...baseRef, nodeId: branch.id });
                const parentLabel = stageLabel(stage);
                emit(out, {
                    event: "branch",
                    ts: new Date().toISOString(),
                    stage: stage.name,
                    stageId: stage.id,
                    stageLabel: parentLabel,
                    id: branch.id,
                    name: branch.name,
                    status: branch.status,
                    durationMillis: branch.durationMillis,
                    path: stage.path,
                    context: stage.context,
                    url: branchUrl,
                });

                if (!isFirstPoll && branch.name.startsWith("Building ") && branch.status !== "IN_PROGRESS") {
                    const branchLabel = `${parentLabel} · ${shortBranchName(branch.name)}`;
                    notifyTransition(ctx, {
                        title: stage.context ? `${ctx.titleBase} · ${stage.context}` : ctx.titleBase,
                        subtitle: `${branchLabel} · build`,
                        body: `${branchLabel}  ${stageNotifyStatus(branch)}`,
                        sound: branch.status === "FAILED" ? "Basso" : undefined,
                        openUrl: branchUrl,
                    });
                }
            }
        }

        if (snap.status !== lastRunStatus) {
            lastRunStatus = snap.status;
            emit(out, { event: "run", ts: new Date().toISOString(), status: snap.status });
        }

        if (isTerminalRun(snap.status)) {
            emit(out, {
                event: "end",
                ts: new Date().toISOString(),
                result: snap.status,
                durationMillis: snap.durationMillis,
                via: "wfapi",
            });
            notifyTransition(ctx, {
                subtitle: "Build finished",
                body: `${statusBody(snap.status)}  ${formatDuration(snap.durationMillis)}`,
                sound: snap.status === "SUCCESS" ? "Glass" : "Basso",
                openUrl: buildHref,
            });
            return { result: snap.status, durationMs: snap.durationMillis, timedOut: false };
        }

        pollsWithoutDelta = stageDelta ? 0 : pollsWithoutDelta + 1;

        if (pollsWithoutDelta >= STALE_POLLS_BEFORE_API_FALLBACK) {
            let state: Awaited<ReturnType<typeof getBuildState>> | null = null;

            try {
                state = await getBuildState(client, jobPath, build);
            } catch (error) {
                logger.debug(
                    `[runMonitor] api-json fallback failed: ${error instanceof Error ? error.message : error}`
                );
            }

            if (state && !state.building && state.result) {
                const final = mapJenkinsResult(state.result);
                const duration = state.duration ?? snap.durationMillis ?? 0;

                if (final === "FAILED") {
                    await emitErrorsForFailedStages(opts, snap, reportedErrors);
                }

                emit(out, {
                    event: "end",
                    ts: new Date().toISOString(),
                    result: final,
                    durationMillis: duration,
                    via: "api-json",
                });
                notifyTransition(ctx, {
                    subtitle: "Build finished",
                    body: `${statusBody(final)}  ${formatDuration(duration)}`,
                    sound: final === "SUCCESS" ? "Glass" : "Basso",
                    openUrl: buildHref,
                });
                return { result: final, durationMs: duration, timedOut: false };
            }
        }

        await sleep(pollMs);
    }

    emit(out, {
        event: "end",
        ts: new Date().toISOString(),
        result: "ABORTED",
        durationMillis: timeoutMs,
    });
    return { result: "ABORTED", durationMs: timeoutMs, timedOut: true };
}

interface NotifyContext {
    notifier: MonitorNotifier | undefined;
    group: string;
    titleBase: string;
}

function notifyTransition(
    ctx: NotifyContext,
    fields: { title?: string; subtitle: string; body: string; sound?: string; openUrl: string }
): void {
    if (!ctx.notifier) {
        return;
    }

    // Fire-and-forget — do not block the poll loop on notification I/O.
    void ctx.notifier
        .send({ title: fields.title ?? ctx.titleBase, group: ctx.group, ...fields })
        .catch((error) => logger.debug(`Notification send failed: ${error instanceof Error ? error.message : error}`));
}

/** Title / subtitle / body all carry parallel-branch context when present. */
function stageNotifyFields(stage: Stage): { titleSuffix?: string; subtitle: string; body: string } {
    const label = stageLabel(stage);
    return {
        // title: "develop #7180 · fee-web" — app scope in the most visible line
        titleSuffix: stage.context,
        subtitle: label,
        body: stageNotifyBody(stage),
    };
}

function seedSnapshotState(
    snap: PipelineSnapshot,
    seenStages: Map<string, StageStatus>,
    seenBranches: Map<string, StageStatus>,
    out: (line: string) => void
): void {
    // Pre-seed NOT_EXECUTED so first-poll doesn't treat declared-but-idle
    // parallel shells as transitions (and we never emit them anyway).
    for (const stage of snap.stages) {
        if (isSilentStatus(stage.status)) {
            seenStages.set(stage.id, stage.status);
        }

        for (const branch of stage.stageFlowNodes ?? []) {
            if (isSilentStatus(branch.status)) {
                seenBranches.set(`${stage.id}.${branch.id}`, branch.status);
            }
        }
    }

    const completed = snap.stages.filter((s) => SNAPSHOT_COMPLETED.includes(s.status));

    if (completed.length === 0) {
        return;
    }

    emit(out, {
        event: "snapshot",
        ts: new Date().toISOString(),
        stages: completed.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            durationMillis: s.durationMillis,
            path: s.path,
            context: s.context,
            label: s.label ?? s.name,
        })),
    });

    for (const stage of completed) {
        seenStages.set(stage.id, stage.status);

        for (const branch of stage.stageFlowNodes ?? []) {
            seenBranches.set(`${stage.id}.${branch.id}`, branch.status);
        }
    }
}

/**
 * A stage is a multibranch "dispatch" if any of its branches is a child build
 * named "Building XXX » ... » Build YYY". For these, the parent stage's duration
 * reflects the orchestration step (often <100ms), not the actual child build —
 * so we label such parent-stage notifications as "orchestration" and fire a
 * separate notification when the child build branch transitions.
 */
function isMultibranchDispatch(stage: Stage): boolean {
    return (stage.stageFlowNodes ?? []).some((n) => n.name.startsWith("Building "));
}

/** Trim "Building Org » Project » Team » Build COL Web" → "Build COL Web". */
function shortBranchName(name: string): string {
    const parts = name.split(" » ");
    return parts[parts.length - 1] ?? name;
}

/**
 * Walk the latest snapshot and fire `emitErrorsForStage` for any FAILED stage
 * we never reported during the normal transition loop. Used when the api-json
 * fallback ends a run that wfapi never marked terminal.
 */
async function emitErrorsForFailedStages(
    opts: MonitorOpts,
    snap: PipelineSnapshot,
    reportedErrors: Set<string>
): Promise<void> {
    for (const stage of snap.stages) {
        if (stage.status !== "FAILED" || reportedErrors.has(stage.id)) {
            continue;
        }

        reportedErrors.add(stage.id);
        await emitErrorsForStage(opts, stage);
    }
}

async function emitErrorsForStage(opts: MonitorOpts, stage: Stage): Promise<void> {
    const failingFlow = stage.stageFlowNodes?.find((n) => n.status === "FAILED");

    if (!failingFlow) {
        return;
    }

    let blocks: ErrorBlock[];

    try {
        const log = await fetchLog(opts.client, opts.jobPath, opts.build, { nodeId: failingFlow.id });
        blocks = extractErrors(log.content);
    } catch (error) {
        logger.debug(
            `Error extraction failed for stage ${stage.id}: ${error instanceof Error ? error.message : error}`
        );
        return;
    }

    for (const block of blocks) {
        opts.out(
            `${SafeJSON.stringify(
                {
                    event: "error",
                    ts: new Date().toISOString(),
                    stage: stageLabel(stage),
                    stageId: stage.id,
                    line: block.line,
                    matched: block.matched,
                    window: block.window,
                },
                { jsonl: true }
            )}\n`
        );
    }
}

function emit(out: (line: string) => void, ev: MonitorEvent): void {
    out(`${SafeJSON.stringify(ev, { jsonl: true })}\n`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function exitCodeFor(result: RunStatus, timedOut: boolean): number {
    if (timedOut) {
        return 124;
    }

    switch (result) {
        case "SUCCESS":
            return 0;
        case "FAILED":
            return 1;
        case "UNSTABLE":
            return 2;
        case "ABORTED":
            return 3;
        case "NOT_EXECUTED":
            return 4;
        default:
            return 1;
    }
}
