import type { AccountUsage } from "@app/claude/lib/usage/api";
import { BUCKET_LABELS, BUCKET_PERIODS_MS, colorForPct } from "@app/claude/lib/usage/constants";
import { formatSpendBalance } from "@app/claude/lib/usage/display";
import type { NormalizedLimit, NormalizedSpend, Severity } from "@app/claude/lib/usage/limits";
import { normalizeLimits, normalizeSpend } from "@app/claude/lib/usage/limits";
import { formatRelativeTime } from "@app/utils/format";
import { useTerminalSize } from "@app/utils/ink/hooks/use-terminal-size";
import { Box, Text } from "ink";
import { UsageBar } from "./usage-bar";

function shortStaleReason(reason: string): string {
    if (reason.includes("429")) {
        return "rate limited";
    }

    if (reason.includes("invalid_grant")) {
        return "needs re-login";
    }

    if (reason.includes("401")) {
        return "auth failed";
    }

    return "fetch failing";
}

function formatResetCountdown(resetsAt: string | null): string | null {
    if (!resetsAt) {
        return null;
    }

    const resetTime = new Date(resetsAt).getTime();
    const remainingMs = resetTime - Date.now();

    if (remainingMs <= 0) {
        // Must fit the fixed countdown slot: " ⟳ " + text <= COUNTDOWN_WIDTH.
        return "resets now";
    }

    const totalMinutes = Math.floor(remainingMs / 60000);
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

    return Math.round((utilization / elapsed) * periodMs);
}

function severityColor(severity: Severity): string {
    if (severity === "critical") {
        return "red";
    }

    if (severity === "warning") {
        return "yellow";
    }

    return "green";
}

// Row layout: [name][bar] [pct] [(~proj%)] [⟳ countdown]
// The countdown rides the bar row when the column is wide enough; on narrow
// columns it drops to an indented second line.
const NAME_WIDTH = 22;
const NARROW_NAME_WIDTH = 16;
// " 100%" + " (~336%)" — projections are capped at "(≥999%)" so this is fixed.
const PCT_PROJ_WIDTH = 13;
// " ⟳ 6d 15h 57m"
const COUNTDOWN_WIDTH = 13;
const MIN_BAR_WIDTH = 8;
// Below this rendered width, rows switch to the narrow name column.
const NARROW_LAYOUT_WIDTH = 60;

/**
 * Narrowest column that still renders label + bar + percent + projection on
 * one row. OverviewView uses this as the two-column gate — anything wider
 * renders cleanly, anything narrower would wrap and corrupt the layout.
 */
export const MIN_ACCOUNT_COLUMN_WIDTH = 40;

interface RowLayout {
    nameWidth: number;
    barWidth: number;
    inlineCountdown: boolean;
}

function layoutFor(width: number): RowLayout {
    const nameWidth = width < NARROW_LAYOUT_WIDTH ? NARROW_NAME_WIDTH : NAME_WIDTH;
    const inlineCountdown = width >= nameWidth + MIN_BAR_WIDTH + PCT_PROJ_WIDTH + COUNTDOWN_WIDTH;
    const barWidth = Math.max(
        MIN_BAR_WIDTH,
        width - nameWidth - PCT_PROJ_WIDTH - (inlineCountdown ? COUNTDOWN_WIDTH : 0)
    );
    return { nameWidth, barWidth, inlineCountdown };
}

function fitLabel(label: string, nameWidth: number): string {
    if (label.length <= nameWidth) {
        return label.padEnd(nameWidth);
    }

    return `${label.slice(0, nameWidth - 2)}… `;
}

function bucketLabel(limit: NormalizedLimit): string {
    const known = BUCKET_LABELS[limit.bucket];
    return known ?? (limit.scope_model ? `Weekly (${limit.scope_model})` : limit.bucket.replace(/_/g, " "));
}

interface BucketRowProps {
    limit: NormalizedLimit;
    layout: RowLayout;
}

function BucketRow({ limit, layout }: BucketRowProps) {
    const countdown = formatResetCountdown(limit.resets_at);
    const notUsed = !limit.resets_at && limit.percent === 0;
    const projected = calcProjection(limit.percent, limit.resets_at, limit.bucket);
    const pct = Math.round(Math.max(0, Math.min(limit.percent, 100)));
    const color = severityColor(limit.severity);

    const projStr = projected !== null && projected >= 100 ? (projected > 999 ? "(≥999%)" : `(~${projected}%)`) : "";
    const projColor = projected !== null ? colorForPct(projected) : undefined;
    const tail = notUsed ? "not used" : countdown ? `⟳ ${countdown}` : "";

    return (
        <Box flexDirection="column">
            <Box>
                <Text dimColor={notUsed}>{fitLabel(bucketLabel(limit), layout.nameWidth)}</Text>
                <UsageBar utilization={limit.percent} width={layout.barWidth} color={color} />
                <Text bold color={notUsed ? undefined : color} dimColor={notUsed}>
                    {`${pct}%`.padStart(5)}
                </Text>
                {projStr ? (
                    <Text dimColor color={projColor}>
                        {` ${projStr}`.padEnd(PCT_PROJ_WIDTH - 5)}
                    </Text>
                ) : (
                    <Text>{" ".repeat(PCT_PROJ_WIDTH - 5)}</Text>
                )}
                {layout.inlineCountdown && tail ? <Text dimColor>{` ${tail}`}</Text> : null}
            </Box>
            {!layout.inlineCountdown && tail ? <Text dimColor>{`${" ".repeat(layout.nameWidth)}${tail}`}</Text> : null}
        </Box>
    );
}

interface SpendRowProps {
    spend: NormalizedSpend;
    layout: RowLayout;
}

function SpendRow({ spend, layout }: SpendRowProps) {
    const label = BUCKET_LABELS.extra_usage ?? "extra credits";
    const balance = formatSpendBalance(spend);
    const pct = Math.round(Math.max(0, Math.min(spend.percent, 100)));
    const color = severityColor(spend.severity);

    return (
        <Box flexDirection="column">
            <Box>
                <Text>{fitLabel(label, layout.nameWidth)}</Text>
                <UsageBar utilization={spend.percent} width={layout.barWidth} color={color} />
                <Text bold color={color}>
                    {`${pct}%`.padStart(5)}
                </Text>
            </Box>
            <Text dimColor>{`${" ".repeat(layout.nameWidth)}${balance}`}</Text>
        </Box>
    );
}

function visibleLimitsFor(account: AccountUsage, prominentBuckets: string[]): NormalizedLimit[] {
    if (!account.usage) {
        return [];
    }

    const limits = normalizeLimits(account.usage);
    const sessionAt100 = limits.some((l) => l.bucket === "five_hour" && l.percent >= 100);
    const weeklyAt100 = limits.some((l) => l.bucket === "seven_day" && l.percent >= 100);

    if (sessionAt100 || weeklyAt100) {
        return limits;
    }

    return limits.filter((l) => prominentBuckets.includes(l.bucket) || l.percent > 0);
}

function bucketRowLines(limit: NormalizedLimit, layout: RowLayout): number {
    if (layout.inlineCountdown) {
        return 1;
    }

    const notUsed = !limit.resets_at && limit.percent === 0;
    return notUsed || limit.resets_at ? 2 : 1;
}

/**
 * Rendered line count of an AccountSection, used by OverviewView to decide
 * when the account list overflows the viewport and must split into columns.
 * MUST mirror the render path below — pass the same width the section will
 * actually be rendered at.
 */
export function estimateAccountHeight(account: AccountUsage, prominentBuckets: string[], width: number): number {
    // Header + marginBottom are always present.
    if (!account.usage) {
        // Error line or "No usage data" line.
        return 3;
    }

    const layout = layoutFor(width);
    let lines = 2;

    if (account.stale && !staleFitsHeader(account, width)) {
        lines += 1;
    }

    for (const limit of visibleLimitsFor(account, prominentBuckets)) {
        lines += bucketRowLines(limit, layout);
    }

    const spend = normalizeSpend(account.usage);
    if (spend?.enabled) {
        lines += 2;
    }

    return lines;
}

function staleHeaderText(account: AccountUsage): string | null {
    if (!account.stale) {
        return null;
    }

    const ago = formatRelativeTime(new Date(account.stale.lastSuccessAt), { compact: true });
    return `⚠ stale ${ago} · ${shortStaleReason(account.stale.reason)}`;
}

/** Whether the stale marker fits on the header line next to name + label. */
function staleFitsHeader(account: AccountUsage, width: number): boolean {
    const stale = staleHeaderText(account);

    if (!stale) {
        return false;
    }

    const headerLen = 2 + account.accountName.length + (account.label ? 2 + account.label.length : 0);
    return headerLen + 2 + stale.length <= width;
}

function worstSeverity(limits: NormalizedLimit[], spend: NormalizedSpend | null): Severity {
    const all: Severity[] = [...limits.map((l) => l.severity), ...(spend?.enabled ? [spend.severity] : [])];

    if (all.includes("critical")) {
        return "critical";
    }

    if (all.includes("warning")) {
        return "warning";
    }

    return "normal";
}

interface AccountHeaderProps {
    account: AccountUsage;
    dotColor: string | undefined;
    staleText?: string | null;
}

function AccountHeader({ account, dotColor, staleText }: AccountHeaderProps) {
    return (
        <Box>
            <Text color={dotColor} dimColor={dotColor === undefined}>
                {dotColor === undefined ? "○ " : "● "}
            </Text>
            <Text bold color="cyan">
                {account.accountName}
            </Text>
            {account.label ? <Text dimColor>{`  ${account.label}`}</Text> : null}
            {staleText ? <Text color="yellow">{`  ${staleText}`}</Text> : null}
        </Box>
    );
}

interface AccountSectionProps {
    account: AccountUsage;
    prominentBuckets: string[];
    /** Column width in cells; defaults to the full terminal width minus padding. */
    width?: number;
}

export function AccountSection({ account, prominentBuckets, width }: AccountSectionProps) {
    const { columns: termWidth } = useTerminalSize();
    const sectionWidth = width ?? termWidth - 2;
    const layout = layoutFor(sectionWidth);

    if (account.error && !account.usage) {
        return (
            <Box flexDirection="column" marginBottom={1}>
                <AccountHeader account={account} dotColor="red" />
                <Text color="red">{`  ${account.error}`}</Text>
            </Box>
        );
    }

    if (!account.usage) {
        return (
            <Box flexDirection="column" marginBottom={1}>
                <AccountHeader account={account} dotColor={undefined} />
                <Text dimColor>{"  No usage data"}</Text>
            </Box>
        );
    }

    const staleText = staleHeaderText(account);
    const staleInline = staleText !== null && staleFitsHeader(account, sectionWidth);

    const spend = normalizeSpend(account.usage);
    const visibleLimits = visibleLimitsFor(account, prominentBuckets);
    const dotColor = severityColor(worstSeverity(visibleLimits, spend));

    return (
        <Box flexDirection="column" marginBottom={1}>
            <AccountHeader
                account={account}
                dotColor={account.stale ? "yellow" : dotColor}
                staleText={staleInline ? staleText : null}
            />
            {staleText && !staleInline ? <Text color="yellow">{`  ${staleText}`}</Text> : null}
            {visibleLimits.map((limit) => (
                <BucketRow key={`${limit.bucket}:${limit.scope_model ?? ""}`} limit={limit} layout={layout} />
            ))}
            {spend?.enabled ? <SpendRow spend={spend} layout={layout} /> : null}
        </Box>
    );
}
