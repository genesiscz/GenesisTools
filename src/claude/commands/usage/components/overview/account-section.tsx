import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { AccountUsage, UsageBucket } from "@app/claude/lib/usage/api";
import { BUCKET_LABELS, BUCKET_PERIODS_MS, colorForPct } from "@app/claude/lib/usage/constants";
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

const NAME_WIDTH = 18;
const BAR_WIDTH = 30;
const PCT_WIDTH = 6;
const PROJ_WIDTH = 12;

interface BucketRowProps {
    bucketKey: string;
    bucket: UsageBucket;
}

function BucketRow({ bucketKey, bucket }: BucketRowProps) {
    const [, setTick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    const label = BUCKET_LABELS[bucketKey] ?? bucketKey.replace(/_/g, " ");
    const countdown = formatResetCountdown(bucket.resets_at);
    const projected = calcProjection(bucket.utilization, bucket.resets_at, bucketKey);
    const showProjection = projected !== null && projected >= 100;
    const pct = Math.round(Math.max(0, Math.min(bucket.utilization, 100)));

    return (
        <Box>
            <Text>{label.padEnd(NAME_WIDTH)}</Text>
            <UsageBar utilization={bucket.utilization} width={BAR_WIDTH} />
            <Text bold>{`${pct}%`.padStart(PCT_WIDTH)}</Text>
            {showProjection ? (
                <Text dimColor color={colorForPct(projected)}>
                    {`~${Math.round(projected)}%`.padStart(PROJ_WIDTH)}
                </Text>
            ) : (
                <Text>{" ".repeat(PROJ_WIDTH)}</Text>
            )}
            {countdown && (
                <Text dimColor>{`  ⟳ ${countdown}`}</Text>
            )}
        </Box>
    );
}

interface AccountSectionProps {
    account: AccountUsage;
    prominentBuckets: string[];
}

export function AccountSection({ account }: AccountSectionProps) {
    const header = account.label
        ? `${account.accountName} (${account.label})`
        : account.accountName;

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

    const allEntries = Object.entries(account.usage).filter(
        ([, v]) => v && typeof v === "object" && "utilization" in v
    ) as Array<[string, UsageBucket]>;

    const sessionAt100 = allEntries.some(([k, b]) => k === "five_hour" && b.utilization >= 100);
    const weeklyAt100 = allEntries.some(([k, b]) => k === "seven_day" && b.utilization >= 100);
    const showAll = sessionAt100 || weeklyAt100;

    const entries = showAll
        ? allEntries
        : allEntries.filter(([key, bucket]) => {
              if (key === "five_hour" || key === "seven_day") {
                  return true;
              }

              return bucket.utilization > 0;
          });

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold>{`── ${header} ${"─".repeat(Math.max(0, 40 - header.length))}`}</Text>
            {entries.map(([key, bucket]) => (
                <BucketRow
                    key={key}
                    bucketKey={key}
                    bucket={bucket}
                />
            ))}
        </Box>
    );
}
