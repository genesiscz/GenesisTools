import { formatDateTime } from "@app/utils/date";
import pc from "picocolors";
import type { AccountUsage } from "./api";
import type { NormalizedSpend, Severity } from "./limits";
import { normalizeLimits, normalizeSpend } from "./limits";

const BAR_WIDTH = 40;
const BLOCK_FULL = "\u2588"; // █
const BLOCK_HALF = "\u258C"; // ▌

const BUCKET_PERIODS_MS: Record<string, number> = {
    five_hour: 5 * 60 * 60 * 1000,
    seven_day: 7 * 24 * 60 * 60 * 1000,
    seven_day_opus: 7 * 24 * 60 * 60 * 1000,
    seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
    seven_day_oauth_apps: 7 * 24 * 60 * 60 * 1000,
};

function colorForPct(pct: number): (s: string) => string {
    if (pct >= 80) {
        return pc.red;
    }
    if (pct >= 50) {
        return pc.yellow;
    }
    return pc.green;
}

function colorForSeverity(severity: Severity): (s: string) => string {
    if (severity === "critical") {
        return pc.red;
    }

    if (severity === "warning") {
        return pc.yellow;
    }

    return pc.green;
}

function renderBar(pct: number, severity: Severity = "normal"): string {
    pct = Math.max(0, Math.min(pct, 100));
    const filled = Math.floor((pct / 100) * BAR_WIDTH);
    const hasHalf = pct > 0 && filled < BAR_WIDTH && ((pct / 100) * BAR_WIDTH) % 1 >= 0.25;
    const color = colorForSeverity(severity);
    const bar = color(BLOCK_FULL.repeat(filled) + (hasHalf ? BLOCK_HALF : ""));
    const empty = " ".repeat(BAR_WIDTH - filled - (hasHalf ? 1 : 0));
    return `${bar}${empty}  ${Math.round(pct)}% used`;
}

const BUCKET_LABELS: Record<string, string> = {
    five_hour: "Current session",
    seven_day: "Current week (all models)",
    seven_day_opus: "Current week (Opus only)",
    seven_day_sonnet: "Current week (Sonnet only)",
    seven_day_oauth_apps: "Current week (OAuth apps)",
    extra_usage: "Extra usage",
};

function bucketLabel(key: string, scopeModel: string | null = null): string {
    const known = BUCKET_LABELS[key];

    if (known) {
        return known;
    }

    return scopeModel ? `Current week (${scopeModel} only)` : key.replace(/_/g, " ");
}

function formatDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts: string[] = [];
    if (days > 0) {
        parts.push(`${days}d`);
    }
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0 || parts.length === 0) {
        parts.push(`${minutes}m`);
    }
    return parts.join(" ");
}

function formatResetTime(resetsAt: string | null): string {
    if (!resetsAt) {
        return "";
    }
    const d = new Date(resetsAt);
    const now = Date.now();
    const remainingMs = d.getTime() - now;

    const formatted = formatDateTime(d, { absolute: "datetime-long" });

    if (remainingMs <= 0) {
        return `Resets ${formatted}`;
    }
    return `Resets ${formatted} (${formatDuration(remainingMs)})`;
}

function calcProjection(utilization: number, resetsAt: string | null, bucketKey: string): number | null {
    if (!resetsAt || utilization <= 0) {
        return null;
    }
    const periodMs = BUCKET_PERIODS_MS[bucketKey];
    if (!periodMs) {
        return null;
    }

    const resetTime = new Date(resetsAt).getTime();
    const now = Date.now();
    const startTime = resetTime - periodMs;
    const elapsed = now - startTime;

    if (elapsed <= 0) {
        return null;
    }

    const projected = (utilization / elapsed) * periodMs;
    return Math.round(projected);
}

function renderProjection(projected: number): string {
    const color = colorForPct(projected);
    return color(`~${projected}% projected at end`);
}

export function renderAccountUsage(account: AccountUsage): string {
    const lines: string[] = [];
    const header = account.label ? `${account.accountName} (${account.label})` : account.accountName;
    lines.push(pc.bold(`── ${header} ${"─".repeat(Math.max(0, 40 - header.length))}`));

    if (account.error) {
        lines.push(pc.red(`  Error: ${account.error}`));
        return lines.join("\n");
    }

    if (!account.usage) {
        return lines.join("\n");
    }

    const limits = normalizeLimits(account.usage);

    for (const limit of limits) {
        if (typeof limit.percent !== "number") {
            continue;
        }

        lines.push(bucketLabel(limit.bucket, limit.scope_model));
        lines.push(renderBar(limit.percent, limit.severity));

        const parts: string[] = [];
        const resetStr = formatResetTime(limit.resets_at);
        if (resetStr) {
            parts.push(resetStr);
        }

        const projected = calcProjection(limit.percent, limit.resets_at, limit.bucket);
        if (projected !== null && projected !== Math.round(limit.percent)) {
            parts.push(renderProjection(projected));
        }

        if (parts.length > 0) {
            lines.push(pc.dim(parts[0]) + (parts[1] ? `  ${parts[1]}` : ""));
        }
        lines.push("");
    }

    const spend = normalizeSpend(account.usage);

    if (spend && spend.enabled) {
        lines.push(bucketLabel("extra_usage"));
        lines.push(renderBar(spend.percent, spend.severity));
        lines.push(pc.dim(`  ${formatSpendBalance(spend)}`));
        lines.push("");
    }

    return lines.join("\n");
}

function formatMinorAmount(amountMinor: number, exponent: number): string {
    return (amountMinor / 10 ** exponent).toFixed(Math.max(0, exponent));
}

export function formatSpendBalance(spend: NormalizedSpend): string {
    const used = formatMinorAmount(spend.used_minor, spend.used_exponent);

    if (spend.limit_minor !== null && spend.limit_exponent !== null) {
        const limit = formatMinorAmount(spend.limit_minor, spend.limit_exponent);
        return `${used} / ${limit} ${spend.used_currency}`;
    }

    if (spend.cap_minor !== null) {
        const cap = formatMinorAmount(spend.cap_minor, spend.used_exponent);
        const currency = spend.cap_currency ?? spend.used_currency;
        return `${used} / ${cap} ${currency}`;
    }

    return `${used} ${spend.used_currency}`;
}

export function renderAllAccounts(accounts: AccountUsage[]): string {
    return accounts.map(renderAccountUsage).join("\n");
}
