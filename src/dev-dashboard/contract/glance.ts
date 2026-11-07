/**
 * The phone's glance (F13, F16, F17, F18): one small snapshot the app copies into its App Group, so the Lock Screen
 * widgets, the icon badge and the fleet Live Activity read the same numbers. `src/hub/lib/glance` builds it. Types
 * only (`contract-purity.test.ts`).
 */
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";

/** The agents that work, wait for the user or went silent, from the agents board's labels. */
export interface GlanceFleetDto {
    working: number;
    waiting: number;
    stalled: number;
    idle: number;
    total: number;
}

/**
 * One answer button of a waiting decision. It carries no act token: the glance is a read, and a read that minted tokens
 * would write the token store on every refresh. The widget stages or sends a letter through the keyed answer routes.
 */
export interface GlanceLetterDto {
    letter: string;
    label: string;
}

/** A waiting decision as the inbox widget shows it. */
export interface GlanceDecisionDto {
    id: string;
    session: string;
    number: number;
    title: string;
    project: string | null;
    recommended: string | null;
    /** The user may pick several letters of this decision. */
    multiple: boolean;
    letters: GlanceLetterDto[];
    at: string;
}

/** The window closest to its cap over every account and provider. */
export interface GlanceLimitDto {
    provider: string;
    account: string;
    window: string;
    /** Percent used, 0 to 100. */
    utilization: number;
    resetsAt: string | null;
    /** When it runs out at the current pace, if before its reset. */
    exhaustAt: string | null;
}

export interface GlanceDto {
    generatedAt: string;
    waiting: {
        /** The notch's badge number (decisions, forms, open dialogs) plus the tool calls that wait for allow or deny. */
        total: number;
        approvals: number;
        /** The oldest waiting ask: the Live Activity's headline. */
        oldest: { title: string; project: string | null; provider: AccountProviderAlias | null; at: string } | null;
    };
    fleet: GlanceFleetDto;
    /** The newest waiting decisions with answer buttons, at most `GLANCE_INBOX_SIZE`. */
    inbox: GlanceDecisionDto[];
    limits: GlanceLimitDto | null;
}

/** How many decisions the inbox widget lists (the large family fits three rows). */
export const GLANCE_INBOX_SIZE = 3;

/** One limit window of an account (`buildForecast`, F16). */
export interface ForecastWindowDto {
    bucket: string;
    kind: "session" | "weekly" | "scoped";
    label: string;
    /** Percent used, 0 to 100. */
    utilization: number;
    resetsAt: string | null;
    lastSampleAt: string;
    ratePctPerHour: number | null;
    /** When it runs out at the current pace; null when the pace never reaches the cap. */
    exhaustAt: string | null;
    minutesToExhaust: number | null;
    /** True when it runs out before its reset. */
    beforeReset: boolean;
    projectedAtReset: number | null;
    resetSinceSample: boolean;
    stale: boolean;
}

export interface ForecastAccountDto {
    provider: string;
    account: string;
    windows: ForecastWindowDto[];
    absentWindows?: string[];
    warning: string | null;
}

/** `GET /api/gateway/forecast`: every Claude, Codex and Grok account's windows, from stored readings only. */
export interface ForecastDto {
    generatedAt: string;
    source: string | null;
    accounts: ForecastAccountDto[];
    elapsedMs: number;
}
