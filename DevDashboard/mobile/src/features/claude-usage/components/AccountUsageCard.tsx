import type { AccountUsage } from "@dd/contract";
import { Text, View } from "react-native";
import { utilizationPct } from "@/features/claude-usage/units";
import { Card } from "@/ui/Card";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

interface AccountUsageCardProps {
    account: AccountUsage;
}

/** A single bucket's current utilization, shown as a label + big percent. */
function BucketStat({ label, value }: { label: string; value: string }) {
    const c = useThemeColors();

    return (
        <View className="items-center">
            <Text className="text-xs uppercase tracking-widest" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {label}
            </Text>
            <Text className="text-xl font-bold" style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                {value}
            </Text>
        </View>
    );
}

/**
 * Current-usage card for one Claude subscription account (feature-local Tier-2). Shows the account
 * name/label and the 5h / 7d / Sonnet-7d utilization percentages, or the account's error. testID
 * `claude-account-<accountName>` is the Appium locator.
 */
export function AccountUsageCard({ account }: AccountUsageCardProps) {
    const c = useThemeColors();
    const title = account.label ? `${account.accountName} · ${account.label}` : account.accountName;

    return (
        <Card testID={`claude-account-${account.accountName}`} className="gap-3">
            <SectionHeader title={title} />
            {account.error ? (
                <Text
                    testID={`claude-account-error-${account.accountName}`}
                    style={{ color: c.danger, fontFamily: "monospace" }}
                >
                    {account.error}
                </Text>
            ) : (
                <View className="flex-row justify-between">
                    <BucketStat label="5h" value={utilizationPct(account.usage?.five_hour)} />
                    <BucketStat label="7d" value={utilizationPct(account.usage?.seven_day)} />
                    <BucketStat label="Sonnet 7d" value={utilizationPct(account.usage?.seven_day_sonnet)} />
                </View>
            )}
        </Card>
    );
}
