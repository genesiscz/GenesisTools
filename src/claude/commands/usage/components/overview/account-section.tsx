import type { AccountUsage } from "@app/claude/lib/usage/api";
import { BUCKET_LABELS, BUCKET_PERIODS_MS, colorForPct } from "@app/claude/lib/usage/constants";
import { formatSpendBalance } from "@app/claude/lib/usage/display";
import type { NormalizedLimit, NormalizedSpend, Severity } from "@app/claude/lib/usage/limits";
import { normalizeLimits, normalizeSpend } from "@app/claude/lib/usage/limits";
import { useTerminalSize } from "@app/utils/ink/hooks/use-terminal-size";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { UsageBar } from "./usage-bar";

function formatResetCountdown(resetsAt: string | null): string | null {
    if (!resetsAt) {
        return null;
    }

    const resetTime = new Date(resetsAt).getTime();
    const remainingMs = resetTime - Date.now();

    if (remainingMs <= 0) {
        return "resetting...";
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

const NAME_WIDTH = 22;
const PCT_WIDTH = 6;
const PROJ_WIDTH = 8;
const FIXED_OVERHEAD = NAME_WIDTH + PCT_WIDTH + PROJ_WIDTH + 2;
const MIN_BAR_WIDTH = 10;

interface BucketRowProps {
    limit: NormalizedLimit;
    barWidth: number;
}

function BucketRow({ limit, barWidth }: BucketRowProps) {
    const [, setTick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    const known = BUCKET_LABELS[limit.bucket];
    const label = known ?? (limit.scope_model ? `Weekly (${limit.scope_model})` : limit.bucket.replace(/_/g, " "));
    const countdown = formatResetCountdown(limit.resets_at);
    const notUsed = !limit.resets_at && limit.percent === 0;
    const projected = calcProjection(limit.percent, limit.resets_at, limit.bucket);
    const pct = Math.round(Math.max(0, Math.min(limit.percent, 100)));

    const projStr = projected !== null && projected >= 100 ? `~${Math.round(projected)}%` : "";
    const projColor = projected !== null ? colorForPct(projected) : undefined;

    return (
        <Box flexDirection="column">
            <Box>
                <Text>{label.padEnd(NAME_WIDTH)}</Text>
                <UsageBar utilization={limit.percent} width={barWidth} color={severityColor(limit.severity)} />
                <Text bold>{`${pct}%`.padStart(PCT_WIDTH)}</Text>
                {projStr ? (
                    <Text dimColor color={projColor}>
                        {projStr.padStart(PROJ_WIDTH)}
                    </Text>
                ) : (
                    <Text>{" ".repeat(PROJ_WIDTH)}</Text>
                )}
            </Box>
            {notUsed ? (
                <Text dimColor>{`${" ".repeat(NAME_WIDTH)}Not used`}</Text>
            ) : countdown ? (
                <Text dimColor>{`${" ".repeat(NAME_WIDTH)}⟳ ${countdown}`}</Text>
            ) : null}
        </Box>
    );
}

interface SpendRowProps {
    spend: NormalizedSpend;
    barWidth: number;
}

function SpendRow({ spend, barWidth }: SpendRowProps) {
    const label = BUCKET_LABELS.extra_usage ?? "extra credits";
    const balance = formatSpendBalance(spend);
    const pct = Math.round(Math.max(0, Math.min(spend.percent, 100)));

    return (
        <Box flexDirection="column">
            <Box>
                <Text>{label.padEnd(NAME_WIDTH)}</Text>
                <UsageBar utilization={spend.percent} width={barWidth} color={severityColor(spend.severity)} />
                <Text bold>{`${pct}%`.padStart(PCT_WIDTH)}</Text>
                <Text>{" ".repeat(PROJ_WIDTH)}</Text>
            </Box>
            <Text dimColor>{`${" ".repeat(NAME_WIDTH)}${balance}`}</Text>
        </Box>
    );
}

interface AccountSectionProps {
    account: AccountUsage;
    prominentBuckets: string[];
}

export function AccountSection({ account, prominentBuckets }: AccountSectionProps) {
    const { columns: termWidth } = useTerminalSize();
    const barWidth = Math.max(MIN_BAR_WIDTH, termWidth - FIXED_OVERHEAD);

    const header = account.label ? `${account.accountName} (${account.label})` : account.accountName;

    if (account.error) {
        return (
            <Box flexDirection="column" marginBottom={1}>
                <Text bold>{`── ${header} ${"─".repeat(Math.max(0, 40 - header.length))}`}</Text>
                <Text color="red">{`  Error: ${account.error}`}</Text>
            </Box>
        );
    }

    if (!account.usage) {
        return (
            <Box flexDirection="column" marginBottom={1}>
                <Text bold>{`── ${header} ${"─".repeat(Math.max(0, 40 - header.length))}`}</Text>
                <Text dimColor>{"  No usage data"}</Text>
            </Box>
        );
    }

    const limits = normalizeLimits(account.usage);
    const spend = normalizeSpend(account.usage);

    const sessionAt100 = limits.some((l) => l.bucket === "five_hour" && l.percent >= 100);
    const weeklyAt100 = limits.some((l) => l.bucket === "seven_day" && l.percent >= 100);
    const showAll = sessionAt100 || weeklyAt100;

    const visibleLimits = showAll ? limits : limits.filter((l) => prominentBuckets.includes(l.bucket) || l.percent > 0);

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold>{`── ${header} ${"─".repeat(Math.max(0, 40 - header.length))}`}</Text>
            {visibleLimits.map((limit) => (
                <BucketRow key={`${limit.bucket}:${limit.scope_model ?? ""}`} limit={limit} barWidth={barWidth} />
            ))}
            {spend?.enabled ? <SpendRow spend={spend} barWidth={barWidth} /> : null}
        </Box>
    );
}
