import type { LimitKind } from "@genesiscz/utils/ai/providers/account-features";
import type { UsageSample } from "@genesiscz/utils/ai/usage/forecast/samples";
import { resetsAtRoughlyEqual } from "@genesiscz/utils/ai/usage-poll/limits-db";

/** The window kinds a budget can target. A credit balance is money and a scoped window follows its weekly one. */
export type BudgetWindowKind = "session" | "weekly" | "monthly";

export const BUDGET_WINDOW_KINDS: readonly BudgetWindowKind[] = ["session", "weekly", "monthly"];

export function isBudgetWindowKind(value: string): value is BudgetWindowKind {
    return (BUDGET_WINDOW_KINDS as readonly string[]).includes(value);
}

/** A target for one window of one account. Either key may be missing; a window with neither has no target. */
export interface WindowBudget {
    /** Keep this many percent of the window unused at its reset. */
    reservePct?: number;
    /** Use at most this many percent per local day; without it the allowance spreads what is left to the reset. */
    dailyAllowancePct?: number;
}

export interface SpendBudget {
    dailyUsd?: number;
}

export type AccountBudget = Partial<Record<BudgetWindowKind, WindowBudget>>;

/**
 * The `budgets` key of the usage dashboard config (design 2026-11-01, proposal 18), nested by axis: spend targets for
 * everything (`global`), then per provider (plugin id) a spend target and window targets keyed by the immutable
 * account id. A missing key means no budget, so the shape needs no migration.
 */
export interface UsageBudgets {
    global: { spend?: SpendBudget };
    providers: Record<string, { spend?: SpendBudget; accounts?: Record<string, AccountBudget> }>;
}

export const EMPTY_BUDGETS: UsageBudgets = { global: {}, providers: {} };

/** The saved form over an empty one, detached from both. */
export function mergeBudgets(saved: Partial<UsageBudgets> | undefined): UsageBudgets {
    return structuredClone({ global: saved?.global ?? {}, providers: saved?.providers ?? {} });
}

export function windowBudgetFor(
    budgets: UsageBudgets,
    window: { provider: string; accountId: string; kind: LimitKind }
): WindowBudget | undefined {
    if (!isBudgetWindowKind(window.kind)) {
        return undefined;
    }

    const budget = budgets.providers[window.provider]?.accounts?.[window.accountId]?.[window.kind];
    return budget && (budget.reservePct !== undefined || budget.dailyAllowancePct !== undefined) ? budget : undefined;
}

export type PaceStatus = "on-pace" | "over-pace" | "under-reserve" | "no-target";

/** How one window stands against its budget today. Percentages are points of the window. */
export interface BudgetPace {
    reservePct: number;
    /** The points today may use; null for a session window, which has no day. */
    allowancePct: number | null;
    /** Points used since local midnight (or since the reset, when the window restarted today). */
    burnedTodayPct: number | null;
    /** burned / allowance; null without an allowance. */
    paceRatio: number | null;
    /** Points left above the reserve now. */
    headroomPct: number;
    status: PaceStatus;
}

const DAY_MS = 86_400_000;

/** The reading at or before `at` within the current cycle, or the cycle's start (0) when the cycle began after it. */
function usedAt(samples: readonly UsageSample[], at: number, resetsAt: string | null): number {
    let used = 0;

    for (const sample of samples) {
        if (Date.parse(sample.timestamp) > at) {
            break;
        }

        used = resetsAt === null || resetsAtRoughlyEqual(sample.resetsAt, resetsAt) ? sample.utilization : 0;
    }

    return used;
}

/**
 * Today's pace of one window against its budget. A weekly or monthly window spreads what is left above the reserve
 * evenly over the days to the reset (the allowance), unless the budget names a daily allowance; "over pace" is today's
 * burn above the allowance times `overPaceFactor`. A session window has only the reserve.
 */
export function windowPace(input: {
    budget: WindowBudget;
    kind: LimitKind;
    utilization: number;
    resetsAt: string | null;
    /** This window's readings, oldest first. */
    samples: readonly UsageSample[];
    now: Date;
    /** Local midnight of today. */
    dayStart: Date;
    overPaceFactor: number;
}): BudgetPace {
    const reservePct = input.budget.reservePct ?? 0;
    const headroomPct = 100 - reservePct - input.utilization;

    if (input.kind === "session") {
        return {
            reservePct,
            allowancePct: null,
            burnedTodayPct: null,
            paceRatio: null,
            headroomPct,
            status: headroomPct < 0 ? "under-reserve" : input.budget.reservePct === undefined ? "no-target" : "on-pace",
        };
    }

    const startUsed = usedAt(input.samples, input.dayStart.getTime(), input.resetsAt);
    const burnedTodayPct = Math.max(0, input.utilization - startUsed);
    const resetMs = input.resetsAt ? Date.parse(input.resetsAt) : Number.NaN;
    const daysLeft = Number.isFinite(resetMs) ? Math.max((resetMs - input.dayStart.getTime()) / DAY_MS, 1) : 1;
    const allowancePct = input.budget.dailyAllowancePct ?? Math.max(0, (100 - reservePct - startUsed) / daysLeft);
    const paceRatio = allowancePct > 0 ? burnedTodayPct / allowancePct : null;
    const over = allowancePct === 0 ? burnedTodayPct > 0 : burnedTodayPct > allowancePct * input.overPaceFactor;

    return {
        reservePct,
        allowancePct,
        burnedTodayPct,
        paceRatio,
        headroomPct,
        status: headroomPct < 0 ? "under-reserve" : over ? "over-pace" : "on-pace",
    };
}

/** Local midnight of `now` in the system zone: the day a budget's allowance belongs to. */
export function localDayStart(now: Date): Date {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
}
