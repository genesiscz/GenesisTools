import { AzureDevOpsCacheManager } from "@app/azure-devops/cache-manager";
import { type EffortRestorePlan, planEffortRestore } from "@app/azure-devops/lib/timelog/effort-restore";
import { formatMinutes, getTodayDate } from "@app/azure-devops/timelog-api";
import {
    type EffortApi,
    type EffortResult,
    readWorkItemEffort,
    updateWorkItemEffort,
} from "@app/azure-devops/timelog-effort";
import { effortJournalPath, findNewestEffortJournal } from "@app/azure-devops/timelog-effort-journal";
import type { TimeLogEntry, TimeLogQueryEntry, TimeLogQueryParams, TimeLogUser } from "@app/azure-devops/types";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";

export interface TimeLogDeleteApi {
    deleteTimeLogEntry(timeLogId: string): Promise<void>;
    getWorkItemTimeLogs(workItemId: number): Promise<TimeLogEntry[]>;
    queryTimeLogs(params: TimeLogQueryParams): Promise<TimeLogQueryEntry[]>;
}

export type ResolvedTimeLog = {
    workItemId: number;
    minutes: number;
    source: "selection" | "workitem" | "journal" | "query";
};

export type DeleteTimeLogResult =
    | { status: "cancelled" }
    | { status: "needs-resolution"; timeLogId: string }
    | { status: "dry-run"; timeLogId: string; resolved: ResolvedTimeLog | null; plan: EffortRestorePlan | null }
    | {
          status: "deleted";
          timeLogId: string;
          resolved: ResolvedTimeLog | null;
          plan: EffortRestorePlan | null;
          effort: EffortResult | null;
      };

export interface DeleteTimeLogOptions {
    timeLogApi: TimeLogDeleteApi;
    devopsApi: EffortApi;
    timeLogId: string;
    user: TimeLogUser;
    projectId: string;
    workItemId?: number;
    knownMinutes?: number;
    noEffort?: boolean;
    dryRun?: boolean;
    confirm?: () => Promise<boolean>;
    journalPath?: string;
    cacheManager?: AzureDevOpsCacheManager;
}

function queryFromDate(): string {
    const from = new Date();
    from.setFullYear(from.getFullYear() - 3);
    return from.toISOString().slice(0, 10);
}

function isLiveQueryEntry(entry: TimeLogQueryEntry): boolean {
    return entry.deletedOn == null;
}

export async function resolveTimeLogForDelete(opts: {
    timeLogApi: TimeLogDeleteApi;
    timeLogId: string;
    user: TimeLogUser;
    projectId: string;
    workItemId?: number;
    knownMinutes?: number;
    journalPath?: string;
}): Promise<ResolvedTimeLog | null> {
    if (opts.workItemId != null && opts.knownMinutes != null) {
        logger.debug(
            `[timelog-delete] resolved ${opts.timeLogId} from selection #${opts.workItemId} ${opts.knownMinutes}m`
        );
        return { workItemId: opts.workItemId, minutes: opts.knownMinutes, source: "selection" };
    }

    if (opts.workItemId != null) {
        const entries = await opts.timeLogApi.getWorkItemTimeLogs(opts.workItemId);
        const hit = entries.find((entry) => entry.timeLogId === opts.timeLogId);

        if (hit) {
            logger.debug(
                `[timelog-delete] resolved ${opts.timeLogId} from work item #${opts.workItemId} ${hit.minutes}m`
            );
            return { workItemId: opts.workItemId, minutes: hit.minutes, source: "workitem" };
        }
    }

    const journal = findNewestEffortJournal(opts.timeLogId, opts.journalPath ?? effortJournalPath());

    if (journal) {
        const entries = await opts.timeLogApi.getWorkItemTimeLogs(journal.workItemId);
        const hit = entries.find((entry) => entry.timeLogId === opts.timeLogId);

        if (hit) {
            logger.debug(
                `[timelog-delete] resolved ${opts.timeLogId} via journal WI #${journal.workItemId} ${hit.minutes}m`
            );
            return { workItemId: journal.workItemId, minutes: hit.minutes, source: "journal" };
        }

        if (journal.timeLogIds.length === 1) {
            logger.debug(
                `[timelog-delete] resolved ${opts.timeLogId} from single-id journal #${journal.workItemId} ${journal.minutes}m`
            );
            return { workItemId: journal.workItemId, minutes: journal.minutes, source: "journal" };
        }
    }

    const fromDate = queryFromDate();
    const toDate = getTodayDate();
    const baseQuery: TimeLogQueryParams = {
        FromDate: fromDate,
        ToDate: toDate,
        projectId: opts.projectId,
    };

    const scoped = await opts.timeLogApi.queryTimeLogs({
        ...baseQuery,
        userId: opts.user.userId,
    });
    const scopedHit = scoped.find((entry) => entry.timeLogId === opts.timeLogId && isLiveQueryEntry(entry));

    if (scopedHit) {
        logger.debug(
            `[timelog-delete] resolved ${opts.timeLogId} from user query #${scopedHit.workItemId} ${scopedHit.minutes}m`
        );
        return { workItemId: scopedHit.workItemId, minutes: scopedHit.minutes, source: "query" };
    }

    const unscoped = await opts.timeLogApi.queryTimeLogs(baseQuery);
    const unscopedHit = unscoped.find((entry) => entry.timeLogId === opts.timeLogId && isLiveQueryEntry(entry));

    if (unscopedHit) {
        logger.debug(
            `[timelog-delete] resolved ${opts.timeLogId} from project query #${unscopedHit.workItemId} ${unscopedHit.minutes}m`
        );
        return { workItemId: unscopedHit.workItemId, minutes: unscopedHit.minutes, source: "query" };
    }

    const unbounded = await opts.timeLogApi.queryTimeLogs({
        projectId: opts.projectId,
        userId: opts.user.userId,
    });
    const unboundedHit = unbounded.find((entry) => entry.timeLogId === opts.timeLogId && isLiveQueryEntry(entry));

    if (unboundedHit) {
        logger.debug(
            `[timelog-delete] resolved ${opts.timeLogId} from unbounded user query #${unboundedHit.workItemId} ${unboundedHit.minutes}m`
        );
        return { workItemId: unboundedHit.workItemId, minutes: unboundedHit.minutes, source: "query" };
    }

    logger.debug(`[timelog-delete] could not resolve ${opts.timeLogId} to a work item`);
    return null;
}

export function formatEffortTransition(plan: EffortRestorePlan): string {
    return `Remaining ${plan.remainingBefore}h → ${plan.remainingAfter}h, Completed ${plan.completedBefore}h → ${plan.completedAfter}h`;
}

export async function deleteTimeLogEntryWithEffort(opts: DeleteTimeLogOptions): Promise<DeleteTimeLogResult> {
    const journalPath = opts.journalPath ?? effortJournalPath();
    let resolved: ResolvedTimeLog | null = null;
    let plan: EffortRestorePlan | null = null;

    if (!opts.noEffort) {
        try {
            resolved = await resolveTimeLogForDelete({
                timeLogApi: opts.timeLogApi,
                timeLogId: opts.timeLogId,
                user: opts.user,
                projectId: opts.projectId,
                workItemId: opts.workItemId,
                knownMinutes: opts.knownMinutes,
                journalPath,
            });
        } catch (err) {
            logger.warn(
                { error: err, timeLogId: opts.timeLogId },
                "[timelog-delete] failed to resolve the time log; delete will skip effort restore"
            );
        }

        if (resolved) {
            try {
                const current = await readWorkItemEffort(opts.devopsApi, resolved.workItemId);
                const journal = findNewestEffortJournal(opts.timeLogId, journalPath);
                plan = planEffortRestore({
                    workItemId: resolved.workItemId,
                    minutes: resolved.minutes,
                    timeLogId: opts.timeLogId,
                    currentRemaining: current?.remaining,
                    currentCompleted: current?.completed,
                    journal,
                });
                logger.debug(
                    `[timelog-delete] restore plan ${plan.reason} for #${resolved.workItemId}: ${formatEffortTransition(plan)}`
                );
            } catch (err) {
                logger.warn(
                    { error: err, workItemId: resolved.workItemId },
                    "[timelog-delete] failed to read work item effort; will delete the row only"
                );
            }
        } else {
            logger.warn(`[timelog-delete] ${opts.timeLogId} not resolved; delete will skip effort restore`);
        }
    }

    if (opts.dryRun) {
        return { status: "dry-run", timeLogId: opts.timeLogId, resolved, plan };
    }

    if (!opts.noEffort && !resolved) {
        logger.warn(
            `[timelog-delete] refusing to delete ${opts.timeLogId} without a work item or minutes; pass --workitem or --no-effort`
        );
        return { status: "needs-resolution", timeLogId: opts.timeLogId };
    }

    if (opts.confirm) {
        const ok = await opts.confirm();

        if (!ok) {
            return { status: "cancelled" };
        }
    }

    await opts.timeLogApi.deleteTimeLogEntry(opts.timeLogId);
    logger.debug(`[timelog-delete] deleted ${opts.timeLogId}`);

    let effort: EffortResult | null = null;

    if (plan && resolved) {
        effort = await updateWorkItemEffort(opts.devopsApi, resolved.workItemId, -resolved.minutes, {
            timeLogIds: [opts.timeLogId],
            journalPath,
            journal: false,
            values: { remaining: plan.remainingAfter, completed: plan.completedAfter },
        });
    }

    const workItemId = resolved?.workItemId ?? opts.workItemId;

    if (workItemId != null) {
        const cache = opts.cacheManager ?? new AzureDevOpsCacheManager();
        cache.onTimelogCreated([workItemId]).catch((err) => {
            logger.debug(`[timelog-delete] Cache eviction failed: ${err}`);
        });
    }

    return { status: "deleted", timeLogId: opts.timeLogId, resolved, plan, effort };
}

export function printDeleteResult(result: DeleteTimeLogResult, opts: { noEffort?: boolean }): void {
    if (result.status === "cancelled" || result.status === "needs-resolution") {
        return;
    }

    const shortId = result.timeLogId.substring(0, 8);
    const prefix = result.status === "dry-run" ? "Would delete" : "Deleted";

    out.println(`\u2714 ${prefix} time log entry ${shortId}...`);

    if (opts.noEffort) {
        out.println(pc.dim("  Work item effort left untouched (--no-effort)"));
        return;
    }

    if (!result.resolved) {
        if (result.status === "dry-run") {
            out.warn(
                pc.yellow(
                    "  ⚠ Could not resolve work item or minutes. The row would be deleted and Remaining/Completed would not change."
                )
            );
            return;
        }

        out.warn(
            pc.yellow(
                "  ⚠ Could not resolve work item or minutes for this entry. The row is gone; Remaining/Completed were not changed."
            )
        );
        return;
    }

    out.println(`  Work Item: #${result.resolved.workItemId}`);
    out.println(`  Time: ${formatMinutes(result.resolved.minutes)}`);

    if (!result.plan) {
        out.warn(pc.yellow("  ⚠ Could not read work item effort fields. Remaining/Completed were not changed."));
        return;
    }

    out.println(`  ${formatEffortTransition(result.plan)}`);

    if (result.plan.reason === "exact-journal") {
        out.println(pc.dim("  Restore: exact (effort journal)"));
    } else if (result.plan.reason === "approximate-no-journal") {
        out.println(pc.dim("  Restore: approximate (no journal record)"));
    } else if (result.plan.reason === "approximate-multi-id") {
        out.println(pc.dim("  Restore: approximate (journal covers a batch)"));
    } else {
        out.println(pc.dim("  Restore: approximate (fields drifted)"));
    }

    if (result.plan.warning) {
        out.warn(pc.yellow(`  ⚠ ${result.plan.warning}`));
    }

    if (result.status === "deleted" && result.plan && result.effort === null) {
        out.warn(
            pc.yellow("  ⚠ Time log row was deleted, but Remaining/Completed could not be written (see warning above).")
        );
    }
}
