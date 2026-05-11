import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { AxiosInstance } from "axios";
import { type ErrorBlock, extractErrors } from "./errors";
import { formatDuration, statusBody } from "./format";
import { fetchLog } from "./log";
import type { MonitorNotifier } from "./notify";
import { getStages, type PipelineSnapshot, type RunStatus, type Stage, type StageStatus } from "./pipeline";
import { buildUrl } from "./url";

export type MonitorEvent =
    | { event: "start"; ts: string; jobPath: string; build: string; url: string }
    | {
          event: "snapshot";
          ts: string;
          stages: Array<{ id: string; name: string; status: StageStatus; durationMillis?: number }>;
      }
    | {
          event: "stage";
          ts: string;
          id: string;
          name: string;
          status: StageStatus;
          durationMillis?: number;
          url: string;
      }
    | {
          event: "branch";
          ts: string;
          stage: string;
          stageId: string;
          id: string;
          name: string;
          status: StageStatus;
          durationMillis?: number;
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
    | { event: "end"; ts: string; result: RunStatus; durationMillis: number };

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

const TERMINAL: RunStatus[] = ["SUCCESS", "FAILED", "UNSTABLE", "ABORTED", "NOT_EXECUTED"];

export async function runMonitor(opts: MonitorOpts): Promise<MonitorResult> {
    const { client, jobPath, build, baseUrl, timeoutMs, pollMs, notifier, out } = opts;
    const group = `jenkins-${jobPath.replace(/\//g, "_")}-${build}`;
    const baseRef = { jobPath, buildNumber: build };
    const buildHref = buildUrl(baseUrl, baseRef);
    const ts0 = new Date().toISOString();

    emit(out, { event: "start", ts: ts0, jobPath, build, url: buildHref });

    let firstPoll = true;
    const seenStages = new Map<string, StageStatus>();
    const seenBranches = new Map<string, StageStatus>();
    const reportedErrors = new Set<string>();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        let snap: PipelineSnapshot;

        try {
            snap = await getStages(client, jobPath, build, { expand: true });
        } catch (error) {
            logger.debug(`Snapshot unavailable: ${error instanceof Error ? error.message : error}`);
            await sleep(pollMs);
            continue;
        }

        if (firstPoll) {
            const completed = snap.stages.filter((s) => TERMINAL.includes(s.status as RunStatus));

            if (completed.length > 0) {
                emit(out, {
                    event: "snapshot",
                    ts: new Date().toISOString(),
                    stages: completed.map((s) => ({
                        id: s.id,
                        name: s.name,
                        status: s.status,
                        durationMillis: s.durationMillis,
                    })),
                });

                for (const s of completed) {
                    seenStages.set(s.id, s.status);

                    for (const b of s.stageFlowNodes ?? []) {
                        seenBranches.set(`${s.id}.${b.id}`, b.status);
                    }
                }
            }
        }

        for (const stage of snap.stages) {
            const last = seenStages.get(stage.id);

            if (last === stage.status) {
                continue;
            }

            seenStages.set(stage.id, stage.status);

            const stageUrl = buildUrl(baseUrl, { ...baseRef, nodeId: stage.id });
            emit(out, {
                event: "stage",
                ts: new Date().toISOString(),
                id: stage.id,
                name: stage.name,
                status: stage.status,
                durationMillis: stage.durationMillis,
                url: stageUrl,
            });

            if (!firstPoll && stage.status !== "IN_PROGRESS") {
                await notifier?.send({
                    title: `${jobPath.split("/").pop()} #${build}`,
                    subtitle: stage.name,
                    body: stageNotifyBody(stage),
                    sound: stage.status === "FAILED" ? "Basso" : undefined,
                    group,
                    openUrl: stageUrl,
                });
            }

            if (stage.status === "FAILED" && !reportedErrors.has(stage.id)) {
                reportedErrors.add(stage.id);
                await emitErrorsForStage(opts, stage);
            }
        }

        for (const stage of snap.stages) {
            for (const branch of stage.stageFlowNodes ?? []) {
                const key = `${stage.id}.${branch.id}`;
                const last = seenBranches.get(key);

                if (last === branch.status) {
                    continue;
                }

                seenBranches.set(key, branch.status);
                emit(out, {
                    event: "branch",
                    ts: new Date().toISOString(),
                    stage: stage.name,
                    stageId: stage.id,
                    id: branch.id,
                    name: branch.name,
                    status: branch.status,
                    durationMillis: branch.durationMillis,
                    url: buildUrl(baseUrl, { ...baseRef, nodeId: branch.id }),
                });
            }
        }

        if (TERMINAL.includes(snap.status as RunStatus)) {
            emit(out, {
                event: "end",
                ts: new Date().toISOString(),
                result: snap.status,
                durationMillis: snap.durationMillis,
            });
            await notifier?.send({
                title: `${jobPath.split("/").pop()} #${build}`,
                subtitle: "Build finished",
                body: `${statusBody(snap.status)}  ${formatDuration(snap.durationMillis)}`,
                sound: snap.status === "SUCCESS" ? "Glass" : "Basso",
                group,
                openUrl: buildHref,
            });
            return { result: snap.status, durationMs: snap.durationMillis, timedOut: false };
        }

        firstPoll = false;
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

function stageNotifyBody(stage: Stage): string {
    if (stage.durationMillis !== undefined) {
        return `${statusBody(stage.status)}  ${formatDuration(stage.durationMillis)}`;
    }

    return statusBody(stage.status);
}

async function emitErrorsForStage(opts: MonitorOpts, stage: Stage): Promise<void> {
    const failingFlow = stage.stageFlowNodes?.find((n) => n.status === "FAILED");

    if (!failingFlow) {
        return;
    }

    let blocks: ErrorBlock[];

    try {
        const log = await fetchLog(opts.client, opts.jobPath, opts.build, { nodeId: failingFlow.id });
        const text = await Bun.file(log.path).text();
        blocks = extractErrors(text);
    } catch (error) {
        logger.debug(
            `Error extraction failed for stage ${stage.id}: ${error instanceof Error ? error.message : error}`
        );
        return;
    }

    for (const block of blocks) {
        opts.out(
            `${SafeJSON.stringify({
                event: "error",
                ts: new Date().toISOString(),
                stage: stage.name,
                stageId: stage.id,
                line: block.line,
                matched: block.matched,
                window: block.window,
            })}\n`
        );
    }
}

function emit(out: (line: string) => void, ev: MonitorEvent): void {
    out(`${SafeJSON.stringify(ev)}\n`);
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
