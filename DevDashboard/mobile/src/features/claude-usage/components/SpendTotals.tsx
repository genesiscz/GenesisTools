import type { UsageTotalsResult } from "@dd/contract";
import { Text, View } from "react-native";
import {
    accountLabel,
    appsSummary,
    formatCount,
    formatTokens,
    formatUsd,
    unpricedHint,
} from "@/features/claude-usage/units";
import { Card } from "@/ui/Card";
import { StatTile } from "@/ui/StatTile";
import { useThemeColors } from "@/theme/colors";

interface SpendTotalsProps {
    totals: UsageTotalsResult;
}

/**
 * Cross-surface token/cost totals from the shared usage layer — mobile parity with the web
 * `claude-usage/SpendTotals`. Deliberately separate from the per-account utilization cards above
 * it: those are Anthropic's subscription limit percentages, these are what every surface actually
 * spent. Unpriced calls are surfaced rather than folded into the cost, so the total reads as a
 * floor rather than an answer.
 */
export function SpendTotals({ totals }: SpendTotalsProps) {
    const c = useThemeColors();
    const { total, accounts, byApp } = totals;

    if (total.events === 0) {
        return (
            <Card testID="claude-spend-totals" className="gap-1">
                <Text
                    className="text-xs uppercase tracking-widest"
                    style={{ color: c.textMuted, fontFamily: "monospace" }}
                >
                    Recorded spend
                </Text>
                <Text
                    testID="claude-spend-empty"
                    className="text-xs"
                    style={{ color: c.textSecondary, fontFamily: "monospace" }}
                >
                    No usage events in this window yet. Rows appear as tools make calls.
                </Text>
            </Card>
        );
    }

    const apps = appsSummary(byApp);

    return (
        <View testID="claude-spend-totals" className="gap-3">
            <View className="flex-row items-baseline justify-between gap-2">
                <Text
                    className="text-xs uppercase tracking-widest"
                    style={{ color: c.textMuted, fontFamily: "monospace" }}
                >
                    Recorded spend
                </Text>
                {apps ? (
                    <Text
                        testID="claude-spend-apps"
                        className="text-xs"
                        style={{ color: c.textMuted, fontFamily: "monospace" }}
                    >
                        {apps}
                    </Text>
                ) : null}
            </View>

            <View className="flex-row flex-wrap gap-3">
                <StatTile
                    testID="claude-spend-cost"
                    label="Cost"
                    value={formatUsd(total.costUsd)}
                    sub={unpricedHint(total.unpricedEvents)}
                />
                <StatTile testID="claude-spend-calls" label="Calls" value={formatCount(total.events)} />
                <StatTile testID="claude-spend-input" label="Input" value={formatTokens(total.inputTokens)} />
                <StatTile testID="claude-spend-output" label="Output" value={formatTokens(total.outputTokens)} />
            </View>

            {accounts.length > 0 ? (
                <Card testID="claude-spend-accounts" className="gap-2">
                    {accounts.map((account) => (
                        <View
                            key={account.key}
                            testID={`claude-spend-account-${account.key}`}
                            className="flex-row items-baseline justify-between gap-3"
                        >
                            <Text
                                className="flex-1 text-xs"
                                numberOfLines={1}
                                style={{
                                    color: account.known ? c.textSecondary : c.textMuted,
                                    fontFamily: "monospace",
                                    fontStyle: account.known ? "normal" : "italic",
                                }}
                            >
                                {accountLabel(account)}
                            </Text>
                            <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                                {formatUsd(account.totals.costUsd)} ·{" "}
                                {formatTokens(account.totals.inputTokens + account.totals.outputTokens)}
                            </Text>
                        </View>
                    ))}
                </Card>
            ) : null}
        </View>
    );
}
