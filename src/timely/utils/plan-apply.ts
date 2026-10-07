import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { TimelyHttpError } from "@app/timely/api/errors";
import type { TimelyService } from "@app/timely/api/service";
import type { TimelyEvent } from "@app/timely/types/api";
import type { CreatePlanV1, PlanIssue } from "@app/timely/types/plan";

import { buildPayloadFromFlat, flattenMemories } from "@app/timely/utils/flatten-memories";
import { fetchMemoriesForDates } from "@app/timely/utils/memories";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Storage } from "@genesiscz/utils/storage";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

interface CreateEventService {
    createEvent(
        accountId: number,
        input: Parameters<TimelyService["createEvent"]>[1]
    ): Promise<Pick<TimelyEvent, "id" | "duration">>;
    getAllEvents?: (
        accountId: number,
        params: { since: string; upto: string }
    ) => Promise<
        Array<
            Pick<TimelyEvent, "id" | "day" | "note" | "from" | "to" | "duration"> & {
                project: Pick<TimelyEvent["project"], "id">;
            }
        >
    >;
}

interface ApplyReceipt {
    identity: string;
    status: "pending" | "created";
    eventId?: number;
    duration: string;
    updatedAt: string;
}

type ApplyReceiptLedger = Record<string, ApplyReceipt>;

/**
 * Receipts are the only record that a create may already have reached Timely, so they live as
 * durable tool state beside the cache, not in it: `tools timely cache clear` must never turn a
 * pending receipt into a blind second POST.
 */
export function applyReceiptPath(accountId: number): string {
    return toolDataDir("timely", "apply-receipts", `${accountId}.json`);
}

async function updateReceiptLedger(
    path: string,
    updater: (current: ApplyReceiptLedger | null) => ApplyReceiptLedger
): Promise<ApplyReceiptLedger> {
    mkdirSync(dirname(path), { recursive: true });

    return withFileLock(`${path}.lock`, async () => {
        const current = existsSync(path)
            ? (SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as ApplyReceiptLedger)
            : null;
        const next = updater(current);
        atomicWriteFileSync(path, SafeJSON.stringify(next, undefined, 2));
        return next;
    });
}

function isDefinitiveCreateRejection(error: unknown): boolean {
    return (
        error instanceof TimelyHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 409, 425, 429].includes(error.status)
    );
}

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
    alreadyApplied?: boolean;
}

export async function applyPlan(args: {
    plan: CreatePlanV1;
    service: CreateEventService;
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

            const identity = createHash("sha256")
                .update(
                    SafeJSON.stringify({
                        accountId: args.accountId,
                        day: planDay.day,
                        projectId: ev.project_id,
                        memoryIds: [...ev.memory_ids].sort((a, b) => a - b),
                        input,
                    })
                )
                .digest("hex");
            const receiptPath = applyReceiptPath(args.accountId);
            let priorReceipt: ApplyReceipt | undefined;

            await updateReceiptLedger(receiptPath, (current) => {
                const ledger = current ?? {};
                priorReceipt = ledger[identity];

                if (priorReceipt) {
                    return ledger;
                }

                return {
                    ...ledger,
                    [identity]: {
                        identity,
                        status: "pending",
                        duration,
                        updatedAt: new Date().toISOString(),
                    },
                };
            });

            if (priorReceipt?.status === "created" && priorReceipt.eventId !== undefined) {
                results.push({
                    day: planDay.day,
                    eventIdx,
                    eventId: priorReceipt.eventId,
                    project_id: ev.project_id,
                    duration: priorReceipt.duration,
                    memoryCount: ev.memory_ids.length,
                    alreadyApplied: true,
                });
                continue;
            }

            if (priorReceipt?.status === "pending") {
                let reconciliationFailure: string | undefined;

                try {
                    const remoteEvents = args.service.getAllEvents
                        ? await args.service.getAllEvents(args.accountId, { since: planDay.day, upto: planDay.day })
                        : [];
                    const matching = remoteEvents.filter(
                        (event) =>
                            event.day === input.day &&
                            event.project?.id === ev.project_id &&
                            event.note === input.note &&
                            event.from === input.from &&
                            event.to === input.to &&
                            // Same bounds can hide different gaps, so the billed time must match
                            // too (to the minute, in case Timely drops the seconds).
                            Math.floor(event.duration.total_seconds / 60) === Math.floor(totalSeconds / 60)
                    );

                    if (matching.length === 1) {
                        const reconciled = matching[0];
                        await updateReceiptLedger(receiptPath, (current) => ({
                            ...(current ?? {}),
                            [identity]: {
                                identity,
                                status: "created",
                                eventId: reconciled.id,
                                duration: reconciled.duration.formatted,
                                updatedAt: new Date().toISOString(),
                            },
                        }));
                        results.push({
                            day: planDay.day,
                            eventIdx,
                            eventId: reconciled.id,
                            project_id: ev.project_id,
                            duration: reconciled.duration.formatted,
                            memoryCount: ev.memory_ids.length,
                            alreadyApplied: true,
                        });
                        continue;
                    }
                } catch (error) {
                    reconciliationFailure = error instanceof Error ? error.message : String(error);
                }

                results.push({
                    day: planDay.day,
                    eventIdx,
                    project_id: ev.project_id,
                    duration,
                    memoryCount: ev.memory_ids.length,
                    error: `previous apply may have reached Timely; no unique remote event matched the pending receipt${reconciliationFailure ? ` (${reconciliationFailure})` : ""}`,
                });
                continue;
            }

            try {
                const created = await args.service.createEvent(args.accountId, input);
                await updateReceiptLedger(receiptPath, (current) => ({
                    ...(current ?? {}),
                    [identity]: {
                        identity,
                        status: "created",
                        eventId: created.id,
                        duration: created.duration.formatted,
                        updatedAt: new Date().toISOString(),
                    },
                }));
                results.push({
                    day: planDay.day,
                    eventIdx,
                    eventId: created.id,
                    project_id: ev.project_id,
                    duration: created.duration.formatted,
                    memoryCount: ev.memory_ids.length,
                });
            } catch (err) {
                if (isDefinitiveCreateRejection(err)) {
                    await updateReceiptLedger(receiptPath, (current) => {
                        const ledger = { ...(current ?? {}) };
                        delete ledger[identity];
                        return ledger;
                    });
                }

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
