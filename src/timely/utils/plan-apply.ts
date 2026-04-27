import type { TimelyService } from "@app/timely/api/service";
import type { TimelyEvent } from "@app/timely/types/api";
import type { CreatePlanV1, PlanIssue } from "@app/timely/types/plan";
import { buildPayloadFromFlat, flattenMemories } from "@app/timely/utils/flatten-memories";
import { fetchMemoriesForDates } from "@app/timely/utils/memories";
import type { Storage } from "@app/utils/storage";

export function validatePlan(plan: CreatePlanV1): PlanIssue[] {
    const issues: PlanIssue[] = [];

    if (plan.version !== 1) {
        issues.push({ severity: "error", day: "*", message: `unsupported plan version ${plan.version}` });
        return issues;
    }

    if (!Array.isArray(plan.days)) {
        issues.push({ severity: "error", day: "*", message: "plan.days must be an array" });
        return issues;
    }

    for (const day of plan.days) {
        if (!Array.isArray(day.available_memories) || !Array.isArray(day.events)) {
            issues.push({
                severity: "error",
                day: day?.day ?? "*",
                message: "day must have array `available_memories` and `events`",
            });
            continue;
        }

        const availableIds = new Set(day.available_memories.map((m) => m.id));
        const seenInDay = new Set<number>();

        for (const [i, ev] of day.events.entries()) {
            if (!Array.isArray(ev.memory_ids)) {
                issues.push({
                    severity: "error",
                    day: day.day,
                    eventIdx: i,
                    message: "event.memory_ids must be an array",
                });
                continue;
            }

            if (ev.memory_ids.length === 0) {
                issues.push({
                    severity: "error",
                    day: day.day,
                    eventIdx: i,
                    message: "event has no memory_ids",
                });
                continue;
            }

            if (!ev.project_id || ev.project_id <= 0) {
                issues.push({
                    severity: "error",
                    day: day.day,
                    eventIdx: i,
                    message: `invalid project_id ${ev.project_id}`,
                });
            }

            const dupInEvent = new Set<number>();
            for (const mid of ev.memory_ids) {
                if (!availableIds.has(mid)) {
                    issues.push({
                        severity: "error",
                        day: day.day,
                        eventIdx: i,
                        message: `memory_id ${mid} not in available_memories`,
                    });
                }

                if (dupInEvent.has(mid)) {
                    issues.push({
                        severity: "error",
                        day: day.day,
                        eventIdx: i,
                        message: `duplicate memory_id ${mid} within event`,
                    });
                }

                dupInEvent.add(mid);

                if (seenInDay.has(mid)) {
                    issues.push({
                        severity: "warn",
                        day: day.day,
                        eventIdx: i,
                        message: `memory_id ${mid} assigned to multiple events on this day`,
                    });
                }

                seenInDay.add(mid);
            }
        }

        if (day.events.length > 0) {
            const unassigned = day.available_memories.filter((m) => !seenInDay.has(m.id));
            if (unassigned.length > 0) {
                const totalMin = unassigned.reduce((sum, m) => sum + m.duration_min, 0);
                issues.push({
                    severity: "warn",
                    day: day.day,
                    message: `${unassigned.length} memory IDs unassigned (~${totalMin}min) — will not be logged`,
                });
            }
        }
    }

    return issues;
}

export interface ApplyResult {
    day: string;
    eventIdx: number;
    eventId?: number;
    project_id: number;
    duration: string;
    memoryCount: number;
    error?: string;
}

export async function applyPlan(args: {
    plan: CreatePlanV1;
    service: TimelyService;
    storage: Storage;
    accountId: number;
    accessToken: string;
    dryRun: boolean;
    onPayload?: (day: string, eventIdx: number, payload: unknown) => void;
}): Promise<ApplyResult[]> {
    const dates = args.plan.days.map((d) => d.day);
    const memoriesResult = await fetchMemoriesForDates({
        accountId: args.accountId,
        accessToken: args.accessToken,
        dates,
        storage: args.storage,
    });

    const results: ApplyResult[] = [];

    for (const planDay of args.plan.days) {
        const rawMemories = memoriesResult.byDate.get(planDay.day) ?? [];

        for (const [eventIdx, ev] of planDay.events.entries()) {
            const allowed = new Set(ev.memory_ids);
            const flat = flattenMemories(rawMemories, allowed);
            if (flat.length === 0) {
                results.push({
                    day: planDay.day,
                    eventIdx,
                    project_id: ev.project_id,
                    duration: "00:00",
                    memoryCount: 0,
                    error: `no flat entries after filter (${ev.memory_ids.length} memory_ids not found in raw memories)`,
                });
                continue;
            }

            const { input, totalSeconds } = buildPayloadFromFlat(flat, planDay.day, ev.project_id, ev.note);
            const duration = formatDuration(totalSeconds);

            if (args.dryRun) {
                args.onPayload?.(planDay.day, eventIdx, input);
                results.push({
                    day: planDay.day,
                    eventIdx,
                    project_id: ev.project_id,
                    duration,
                    memoryCount: ev.memory_ids.length,
                });
                continue;
            }

            try {
                const created: TimelyEvent = await args.service.createEvent(args.accountId, input);
                results.push({
                    day: planDay.day,
                    eventIdx,
                    eventId: created.id,
                    project_id: ev.project_id,
                    duration: created.duration.formatted,
                    memoryCount: ev.memory_ids.length,
                });
            } catch (err) {
                results.push({
                    day: planDay.day,
                    eventIdx,
                    project_id: ev.project_id,
                    duration,
                    memoryCount: ev.memory_ids.length,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    return results;
}

function formatDuration(totalSec: number): string {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
