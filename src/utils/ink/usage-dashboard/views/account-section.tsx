import type { AccountUsageSnapshot, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";
import { formatMoney } from "@genesiscz/utils/ai/usage-poll/format-money";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { Box, Text } from "ink";
import { UsageBar } from "../components/usage-bar";
import { colorForWindow, colorForWindowKey, type UsageColor } from "../lib/colors";

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
 * Windows to render. A `prominent` list both selects and orders them: the compact views
 * show that subset only, which is what `prominentBuckets` means in the dashboard config.
 * An empty or omitted list shows everything the provider returned.
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

    return out;
}

/**
 * The default per-account block: a title line and one bar per limit window. A provider
 * that wants more (the anthropic Overview) supplies `presenters.AccountSection` instead.
 */
export function GenericAccountSection({
    snapshot,
    width = 60,
    prominent,
    colorFor = colorForWindow,
    now = Date.now(),
}: GenericAccountSectionProps) {
    const windows = orderWindows(snapshot.limits, prominent);
    const barWidth = Math.max(10, Math.min(30, width - LABEL_WIDTH - 12));

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text bold color="cyan">
                    {snapshot.label ?? snapshot.accountName}
                </Text>
                <Text dimColor>{`  ${snapshot.provider}`}</Text>
                {snapshot.plan?.name ? <Text dimColor>{`  ${snapshot.plan.name}`}</Text> : null}
                {snapshot.stale ? (
                    <Text color="yellow">{`  ! stale ${formatRelativeTime(new Date(snapshot.stale.lastSuccessAt))}`}</Text>
                ) : null}
            </Box>
            {snapshot.error ? (
                <Box>
                    <Text color="red">{`  × ${snapshot.error}`}</Text>
                </Box>
            ) : null}
            {windows.map((window) => {
                const money = formatMoney(window);
                const color = colorFor(window, now);

                return (
                    <Box key={window.key}>
                        <Text color={colorForWindowKey(window.key)}>{window.label.padEnd(LABEL_WIDTH)}</Text>
                        <UsageBar utilization={window.percentUsed} width={barWidth} color={color} />
                        <Text bold color={color}>
                            {` ${window.percentUsed.toFixed(1)}%`}
                        </Text>
                        {money ? <Text dimColor>{`  ${money}`}</Text> : null}
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
