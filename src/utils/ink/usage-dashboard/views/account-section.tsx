import type { AccountUsageSnapshot, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";
import { formatBlockedNotice, formatNeedsLoginNotice } from "@genesiscz/utils/ai/usage-poll/format-blocked";
import { formatMoney, percentOf } from "@genesiscz/utils/ai/usage-poll/format-money";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { Box, Text } from "ink";
import { UsageBar } from "../components/usage-bar";
import { colorForWindow, colorForWindowKey, isResetImminent, type UsageColor } from "../lib/colors";
import { windowTail } from "../lib/reset-countdown";

export interface GenericAccountSectionProps {
    snapshot: AccountUsageSnapshot;
    width?: number;
    /** Window keys to show. Empty or omitted means every window the provider returned. */
    prominent?: string[];
    /** The provider presenter's own bar colour (spec 7.3). Defaults to the shared rule. */
    colorFor?: (window: LimitWindow, now: number) => UsageColor;
    now?: number;
}

/** Cells reserved for the label column, so the bars line up across accounts. */
const LABEL_WIDTH = 16;

/**
 * Windows to render. A `prominent` list orders them and is what the compact views show
 * while nothing else is spent, which is what `prominentBuckets` means in the dashboard
 * config. A window that is not prominent but carries usage follows anyway, the rule the
 * anthropic presenter always had: a per-model pool at 40% hidden behind a config default
 * is the one row the reader needed (codex Spark, 2026-09-10). An empty or omitted list
 * shows everything the provider returned.
 */
export function orderWindows(limits: readonly LimitWindow[], prominent?: string[]): LimitWindow[] {
    if (!prominent || prominent.length === 0) {
        return [...limits];
    }

    const byKey = new Map(limits.map((w) => [w.key, w]));
    const out: LimitWindow[] = [];

    for (const key of prominent) {
        const window = byKey.get(key);

        if (window) {
            out.push(window);
            byKey.delete(key);
        }
    }

    for (const window of byKey.values()) {
        if (window.percentUsed > 0) {
            out.push(window);
        }
    }

    return out;
}

/**
 * The default per-account block: a title line and one bar per limit window. A provider
 * that wants more (the anthropic Overview) supplies `presenters.AccountSection` instead.
 */
/**
 * The title line as plain strings: the account NAME, the provider, then the plan once.
 * Codex and grok store the plan as the account label too, so a title of
 * `label ?? accountName` drew "pro  openai-sub  pro" and hid which account the block
 * was (2026-09-10); the anthropic presenter always led with the name.
 */
export function accountHeaderParts(snapshot: AccountUsageSnapshot): string[] {
    const plan = snapshot.plan?.name ?? snapshot.label;
    return plan ? [snapshot.accountName, snapshot.provider, plan] : [snapshot.accountName, snapshot.provider];
}

export function GenericAccountSection({
    snapshot,
    width = 60,
    prominent,
    colorFor = colorForWindow,
    now = Date.now(),
}: GenericAccountSectionProps) {
    const windows = orderWindows(snapshot.limits, prominent);
    const header = accountHeaderParts(snapshot);
    const barWidth = Math.max(10, Math.min(30, width - LABEL_WIDTH - 12));
    // While the gate holds the account back nothing was requested this round, so the raw
    // error alone would read as a failure happening right now.
    const blockedNotice = formatBlockedNotice(snapshot, now);
    const needsLoginNotice = formatNeedsLoginNotice(snapshot);

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text bold color="cyan">
                    {header[0]}
                </Text>
                <Text dimColor>{`  ${header.slice(1).join("  ")}`}</Text>
                {snapshot.stale ? (
                    <Text color="yellow">{`  ! stale ${formatRelativeTime(new Date(snapshot.stale.lastSuccessAt))}`}</Text>
                ) : null}
            </Box>
            {blockedNotice ? (
                <Box>
                    <Text color="yellow">{`  ⏸ ${blockedNotice}`}</Text>
                </Box>
            ) : needsLoginNotice ? (
                <Box>
                    <Text color="red">{`  ⚠ ${needsLoginNotice}`}</Text>
                </Box>
            ) : snapshot.error ? (
                <Box>
                    <Text color="red">{`  × ${snapshot.error}`}</Text>
                </Box>
            ) : null}
            {windows.map((window) => {
                const money = formatMoney(window);
                const color = colorFor(window, now);
                // The reset is the one number a spent window is really about, and this
                // block drew none of it (2026-09-10): codex and grok accounts showed a
                // percent and nothing else while the anthropic presenter counted down.
                const tail = windowTail(window, now);
                const imminent = isResetImminent(window, now);

                return (
                    <Box key={window.key}>
                        <Text color={colorForWindowKey(window.key)}>{window.label.padEnd(LABEL_WIDTH)}</Text>
                        <UsageBar utilization={percentOf(window)} width={barWidth} color={color} />
                        <Text bold color={color}>
                            {` ${percentOf(window).toFixed(1)}%`}
                        </Text>
                        {money ? <Text dimColor>{`  ${money}`}</Text> : null}
                        {tail ? (
                            <Text dimColor={!imminent} color={imminent ? "green" : undefined}>{`  ${tail}`}</Text>
                        ) : null}
                    </Box>
                );
            })}
            {windows.length === 0 && !snapshot.error ? (
                <Box>
                    <Text dimColor>{"  no limit windows reported"}</Text>
                </Box>
            ) : null}
        </Box>
    );
}
