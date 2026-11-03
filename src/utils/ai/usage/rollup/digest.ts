import type { StoredAlert } from "@genesiscz/utils/ai/usage/alerts/types";
import type { AttributedEvent } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import type { DailyRow } from "./daily";

/** `usage.digest@1`. */
export const USAGE_DIGEST_SCHEMA = { verb: "digest", version: 1 } as const;

export type DigestPeriod = "day" | "week";

/** One account's window over the period, from its daily rows. */
export interface DigestWindow {
    account: AccountKey;
    kind: string | null;
    key: string;
    startPct: number;
    endPct: number;
    peakPct: number;
    resets: number;
    cyclesOver90: number;
    /** The first day of the period the window was absent and stayed absent; null while it has a limit. */
    noLimitSince: string | null;
    days: number;
    minutesMeasured: number | null;
}

export interface DigestSession {
    agent: AttributedEvent["agent"];
    sessionId: string;
    project: string;
    account: AccountKey | null;
    costUsd: number;
    next: string;
}

export interface DigestSpend {
    totalUsd: number;
    byProvider: Array<{ provider: string; usd: number }>;
    byModel: Array<{ model: string; usd: number }>;
    topSessions: DigestSession[];
    /** Events with no known rate; their dollars are missing, never zero. */
    unpriced: number;
}

export interface DigestOutlookRow {
    account: AccountKey;
    label: string;
    utilization: number;
    exhaustAt: string | null;
    resetsAt: string | null;
}

export interface DigestWorkers {
    byBackend: Array<{ backend: string; turns: number; apiEquivalentUsd: number; failedTurns: number }>;
}

export interface UsageDigest {
    period: DigestPeriod;
    /** Local day keys of the period, oldest first. */
    days: string[];
    windows: DigestWindow[];
    alerts: { total: number; byRule: Record<string, number>; budget: number };
    spend: DigestSpend;
    outlook: DigestOutlookRow[];
    workers: DigestWorkers | null;
}

/** Folds the period's daily rows into one row per account, window and kind (a slot can change kind on a plan change). */
export function digestWindows(rows: readonly DailyRow[], keyOf: (row: DailyRow) => AccountKey): DigestWindow[] {
    const groups = new Map<string, DailyRow[]>();

    for (const row of rows) {
        const id = `${row.provider}\u0000${row.accountName}\u0000${row.bucket}\u0000${row.kind ?? ""}`;
        groups.set(id, [...(groups.get(id) ?? []), row]);
    }

    return [...groups.values()].map((list) => {
        const sorted = [...list].sort((a, b) => a.day.localeCompare(b.day));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        // A day the window was absent with no reading stores 0s, which were never measured: the period's start and end
        // come from the first and last day with a reading (the edge days only when none has one).
        const read = sorted.filter((row) => row.readings > 0);
        const startRow = read[0] ?? first;
        const endRow = read.at(-1) ?? last;
        const absentFrom = sorted.findIndex((row, index) =>
            sorted.slice(index).every((r) => r.availability === "absent")
        );
        const measured = sorted.map((row) => row.minutesMeasured).filter((value): value is number => value !== null);

        return {
            account: keyOf(first),
            kind: first.kind,
            key: first.bucket,
            startPct: startRow.startPct,
            endPct: endRow.endPct,
            peakPct: Math.max(...sorted.map((row) => row.peakPct)),
            resets: sorted.reduce((sum, row) => sum + row.resets, 0),
            cyclesOver90: sorted.reduce((sum, row) => sum + row.cyclesOver90, 0),
            noLimitSince: absentFrom >= 0 ? sorted[absentFrom].day : null,
            days: sorted.length,
            minutesMeasured: measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) : null,
        };
    });
}

/** The period's spend by provider, by model, and its five costliest sessions. */
export function digestSpend(
    events: readonly AttributedEvent[],
    reportCommand: (sessionId: string) => string
): DigestSpend {
    const byProvider = new Map<string, number>();
    const byModel = new Map<string, number>();
    const sessions = new Map<string, DigestSession>();
    let totalUsd = 0;
    let unpriced = 0;

    for (const event of events) {
        totalUsd += event.costUsd;
        unpriced += event.unpriced ? 1 : 0;
        byProvider.set(event.provider, (byProvider.get(event.provider) ?? 0) + event.costUsd);
        byModel.set(event.model ?? "?", (byModel.get(event.model ?? "?") ?? 0) + event.costUsd);
        const id = `${event.agent}\u0000${event.owner.leadSessionId}`;
        const session = sessions.get(id) ?? {
            agent: event.agent,
            sessionId: event.owner.leadSessionId,
            project: event.owner.project,
            account: event.account.account ?? null,
            costUsd: 0,
            next: reportCommand(event.owner.leadSessionId),
        };
        session.costUsd += event.costUsd;
        sessions.set(id, session);
    }

    const sorted = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);

    return {
        totalUsd,
        byProvider: sorted(byProvider).map(([provider, usd]) => ({ provider, usd })),
        byModel: sorted(byModel).map(([model, usd]) => ({ model, usd })),
        topSessions: [...sessions.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 5),
        unpriced,
    };
}

export function digestAlerts(alerts: readonly StoredAlert[]): UsageDigest["alerts"] {
    const byRule: Record<string, number> = {};

    for (const alert of alerts) {
        byRule[alert.rule] = (byRule[alert.rule] ?? 0) + 1;
    }

    return { total: alerts.length, byRule, budget: byRule.budget ?? 0 };
}

function usd(value: number): string {
    return `$${value.toFixed(2)}`;
}

/** The digest as a markdown note: the vault note and `--md`. */
export function digestMarkdown(digest: UsageDigest, title: string): string {
    const lines = [`# ${title}`, ""];
    const range = digest.days.length > 1 ? `${digest.days[0]} to ${digest.days.at(-1)}` : (digest.days[0] ?? "");
    lines.push(`${range} · ${usd(digest.spend.totalUsd)} spent · ${digest.alerts.total} alerts`, "", "## Limits", "");

    for (const window of digest.windows) {
        const name = `${window.account.provider}/${window.account.accountName} ${window.kind ?? window.key}`;

        if (window.noLimitSince) {
            lines.push(`- ${name}: no limit since ${window.noLimitSince}`);
            continue;
        }

        const ninety = window.kind === "session" ? ` · ${window.cyclesOver90} windows reached 90%` : "";
        lines.push(
            `- ${name}: ${window.startPct.toFixed(0)}% → ${window.endPct.toFixed(0)}%, peak ${window.peakPct.toFixed(0)}%, ${window.resets} resets${ninety}`
        );
    }

    if (digest.windows.length === 0) {
        lines.push("- no readings");
    }

    lines.push("", "## Spend", "");
    lines.push(...digest.spend.byProvider.map((row) => `- ${row.provider}: ${usd(row.usd)}`));
    lines.push("", "Top sessions:", "");
    lines.push(
        ...digest.spend.topSessions.map(
            (session) => `- ${usd(session.costUsd)} ${session.agent} \`${session.sessionId}\` ${session.project}`
        )
    );

    if (digest.spend.unpriced > 0) {
        lines.push("", `${digest.spend.unpriced} events had no known rate; their cost is missing.`);
    }

    if (digest.workers) {
        lines.push("", "## Workers", "");
        lines.push(
            ...digest.workers.byBackend.map(
                (row) => `- ${row.backend}: ${row.turns} turns, ${usd(row.apiEquivalentUsd)}, ${row.failedTurns} failed`
            )
        );
    }

    lines.push("", "## Alerts", "");
    lines.push(...Object.entries(digest.alerts.byRule).map(([rule, count]) => `- ${rule}: ${count}`));

    if (digest.alerts.total === 0) {
        lines.push("- none");
    }

    if (digest.outlook.length > 0) {
        lines.push("", "## Outlook", "");
        lines.push(
            ...digest.outlook.map(
                (row) =>
                    `- ${row.account.provider}/${row.account.accountName} ${row.label} at ${row.utilization.toFixed(0)}%, runs out ${row.exhaustAt ?? "?"} before its reset ${row.resetsAt ?? "?"}`
            )
        );
    }

    return `${lines.join("\n")}\n`;
}
