import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountHistoryCharts } from "@/features/claude-usage/components/AccountHistoryCharts";
import { AccountUsageCard } from "@/features/claude-usage/components/AccountUsageCard";
import { RangeSelector, USAGE_RANGES } from "@/features/claude-usage/components/RangeSelector";
import { useUsageAccounts } from "@/features/claude-usage/hooks";
import { MockBadge } from "@/ui/MockBadge";
import { useThemeColors } from "@/theme/colors";

/**
 * Claude usage screen — per-account current-utilization cards + token burn-down history charts with
 * a 1h/24h/7d range control. Composes feature components off the per-feature `useUsageAccounts` hook
 * (D32 — never raw useQuery). Parity with the web `routes/claude.tsx` (account cards + history),
 * single-series charts (one per bucket) since the shared `MetricChart` is single-series.
 */
export default function ClaudeUsageScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const accountsQuery = useUsageAccounts();
    const [rangeMinutes, setRangeMinutes] = useState<number>(USAGE_RANGES[2].minutes);

    const accounts = accountsQuery.data ?? [];

    if (accountsQuery.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Claude Usage" }} />
                <View testID="screen-claude-usage" accessibilityLabel="screen-claude-usage" className="flex-1 items-center justify-center bg-dd-bg-base">
                    <View testID="claude-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Loading usage…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (accountsQuery.isError) {
        return (
            <>
                <Stack.Screen options={{ title: "Claude Usage" }} />
                <View testID="screen-claude-usage" accessibilityLabel="screen-claude-usage" className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6">
                    <Text testID="claude-error" className="text-base font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                        Usage unavailable
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {accountsQuery.error instanceof Error ? accountsQuery.error.message : "Could not reach the agent."}
                    </Text>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: "Claude Usage" }} />
            <ScrollView
                testID="screen-claude-usage"
                accessibilityLabel="screen-claude-usage"
                className="flex-1 bg-dd-bg-base"
                contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16 }}
            >
                <MockBadge />

                {accounts.length === 0 ? (
                    <Text testID="claude-empty" className="py-8 text-center" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        No Claude subscription accounts configured.
                    </Text>
                ) : (
                    <>
                        {accounts.map((account) => (
                            <AccountUsageCard key={account.accountName} account={account} />
                        ))}

                        <RangeSelector value={rangeMinutes} onChange={setRangeMinutes} />

                        {accounts.map((account) => (
                            <AccountHistoryCharts
                                key={account.accountName}
                                accountName={account.accountName}
                                label={account.label}
                                rangeMinutes={rangeMinutes}
                            />
                        ))}
                    </>
                )}
            </ScrollView>
        </>
    );
}
