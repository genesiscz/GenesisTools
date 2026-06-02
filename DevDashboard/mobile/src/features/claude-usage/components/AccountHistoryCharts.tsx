import { Text, View } from "react-native";
import { useUsageHistory } from "@/features/claude-usage/hooks";
import { historyToBucketSeries } from "@/features/claude-usage/units";
import { Card } from "@/ui/Card";
import { MetricChart } from "@/ui/MetricChart";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

interface AccountHistoryChartsProps {
    accountName: string;
    label?: string;
    rangeMinutes: number;
}

const formatX = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));

/**
 * Token burn-down history for one account: one shared `MetricChart` (area, 0-100% y-domain) per
 * bucket the agent returns. Consumes the per-feature `useUsageHistory` hook (D32 — never raw
 * useQuery). Renders the agent's `hint` (or a default) when there is no history yet. testID
 * `claude-history-<accountName>` wraps the bucket charts; each chart is `claude-chart-<account>-<bucket>`.
 */
export function AccountHistoryCharts({ accountName, label, rangeMinutes }: AccountHistoryChartsProps) {
    const c = useThemeColors();
    const history = useUsageHistory(accountName, rangeMinutes);
    const series = history.data ? historyToBucketSeries(history.data) : [];
    const allEmpty = series.length === 0 || series.every((s) => s.points.length === 0);
    const title = label ? `${accountName} · ${label}` : accountName;

    return (
        <Card testID={`claude-history-${accountName}`} className="gap-3">
            <SectionHeader title={`${title} — history`} />
            {allEmpty ? (
                <Text
                    testID={`claude-history-empty-${accountName}`}
                    className="py-6 text-center"
                    style={{ color: c.textMuted, fontFamily: "monospace" }}
                >
                    {history.data?.hint ?? "No history yet."}
                </Text>
            ) : (
                <View className="gap-4">
                    {series.map((bucket) => (
                        <MetricChart
                            key={bucket.key}
                            testID={`claude-chart-${accountName}-${bucket.key}`}
                            title={bucket.label}
                            points={bucket.points}
                            unit="%"
                            domain={[0, 100]}
                            formatX={formatX}
                        />
                    ))}
                </View>
            )}
        </Card>
    );
}
