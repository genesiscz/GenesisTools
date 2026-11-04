import { titleMatchKeys } from "@app/cmux/lib/title-match";
import type { GlanceDecisionDto, GlanceDto, GlanceFleetDto, GlanceLimitDto } from "@app/dev-dashboard/contract/glance";
import { GLANCE_INBOX_SIZE } from "@app/dev-dashboard/contract/glance";
import { loadWaitingQueue, type WaitingQueue } from "@app/question/lib/inbox/load";
import { type FleetEntry, readFleetView } from "@genesiscz/utils/ai/live-sessions/fleet";
import { FLEET_PHASES } from "@genesiscz/utils/ai/live-sessions/phase";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { buildForecast, type ForecastResult } from "@genesiscz/utils/ai/usage/forecast/forecast";
import { logger } from "@genesiscz/utils/logger";
import { listPendingApprovals } from "../approvals/index";
import type { PendingApproval } from "../approvals/types";

const log = logger.child({ component: "hub/glance" });

/** The glance's sources; tests pass fixed ones. */
export interface GlanceSources {
    waiting(): Promise<WaitingQueue>;
    approvals(): Promise<PendingApproval[]>;
    fleet(): Promise<Pick<FleetEntry, "label">[]>;
    forecast(): Promise<ForecastResult>;
}

export function liveGlanceSources(): GlanceSources {
    return {
        waiting: () => loadWaitingQueue(),
        approvals: () => listPendingApprovals(),
        fleet: () => readFleetView({ titleKeys: titleMatchKeys }),
        forecast: () => buildForecast({}),
    };
}

/** Working, waiting, stalled and idle agents, by the fleet labels' own flags. */
export function fleetCounts(entries: readonly Pick<FleetEntry, "label">[]): GlanceFleetDto {
    const counts: GlanceFleetDto = { working: 0, waiting: 0, stalled: 0, idle: 0, total: entries.length };

    for (const { label } of entries) {
        if (label === "stalled") {
            counts.stalled += 1;
        } else if (label === "unknown") {
            counts.idle += 1;
        } else if (FLEET_PHASES[label].needsUser) {
            counts.waiting += 1;
        } else if (FLEET_PHASES[label].running) {
            counts.working += 1;
        } else {
            counts.idle += 1;
        }
    }

    return counts;
}

/** The newest waiting decisions with their letters, at most `GLANCE_INBOX_SIZE`. */
export function inboxOf(queue: WaitingQueue): GlanceDecisionDto[] {
    const decisions: GlanceDecisionDto[] = [];

    for (const session of queue.sessions) {
        for (const item of session.items) {
            if (item.kind !== "decision" || !session.sessionId) {
                continue;
            }

            decisions.push({
                id: item.id,
                session: session.sessionId,
                number: item.number,
                title: item.title ?? item.prompt.split("\n")[0],
                project: session.project,
                recommended: item.recommended,
                letters: item.choices.map((choice) => ({ letter: choice.id, label: choice.label })),
                at: item.at,
            });
        }
    }

    return decisions.sort((a, b) => b.at.localeCompare(a.at)).slice(0, GLANCE_INBOX_SIZE);
}

/** The oldest waiting ask over the queue: the Live Activity's headline. */
function oldestOf(queue: WaitingQueue): GlanceDto["waiting"]["oldest"] {
    let oldest: GlanceDto["waiting"]["oldest"] = null;

    for (const session of queue.sessions) {
        for (const item of session.items) {
            const title =
                item.kind === "form" ? (item.questions[0]?.prompt ?? "") : (item.title ?? item.prompt).split("\n")[0];
            const at = item.at;

            if (!oldest || at < oldest.at) {
                oldest = {
                    title: title || session.title || "a question",
                    project: session.project,
                    provider: session.provider && isAccountProviderAlias(session.provider) ? session.provider : null,
                    at,
                };
            }
        }
    }

    return oldest;
}

/** The fresh window closest to its cap over every account and provider. */
export function closestLimit(forecast: ForecastResult): GlanceLimitDto | null {
    let best: GlanceLimitDto | null = null;

    for (const account of forecast.accounts) {
        for (const window of account.windows) {
            if (window.stale || window.resetSinceSample) {
                continue;
            }

            if (!best || window.utilization > best.utilization) {
                best = {
                    provider: account.provider,
                    account: account.account,
                    window: window.label,
                    utilization: window.utilization,
                    resetsAt: window.resetsAt,
                    exhaustAt: window.beforeReset ? window.exhaustAt : null,
                };
            }
        }
    }

    return best;
}

async function read<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await run();
    } catch (error) {
        log.warn({ error, source: name }, "a glance source could not be read; it counts as empty");
        return fallback;
    }
}

/**
 * The phone's glance (F13, F16, F17, F18): the waiting count with the open approvals, the fleet counts, the newest
 * decisions with their letters, and the window closest to its cap. Read only: it mints no act token and fetches no
 * account (the forecast reads stored readings), so a widget may refresh it as often as Apple lets it.
 */
export async function buildGlance(
    sources: GlanceSources = liveGlanceSources(),
    now: Date = new Date()
): Promise<GlanceDto> {
    const emptyQueue: WaitingQueue = { total: 0, sessions: [], at: now.toISOString() };
    const [queue, approvals, fleet, forecast] = await Promise.all([
        read("waiting", sources.waiting, emptyQueue),
        read("approvals", sources.approvals, []),
        read("fleet", sources.fleet, []),
        read("forecast", sources.forecast, {
            generatedAt: now.toISOString(),
            source: null,
            accounts: [],
            elapsedMs: 0,
        }),
    ]);

    return {
        generatedAt: now.toISOString(),
        waiting: { total: queue.total + approvals.length, approvals: approvals.length, oldest: oldestOf(queue) },
        fleet: fleetCounts(fleet),
        inbox: inboxOf(queue),
        limits: closestLimit(forecast),
    };
}
