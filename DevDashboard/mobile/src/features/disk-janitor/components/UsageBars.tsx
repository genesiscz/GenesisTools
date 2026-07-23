import type { DiskUsageEntry } from "@dd/contract";
import { Text, View } from "react-native";
import { formatBytes, type RankedDiskEntry, withPercentOfMax } from "@/features/disk-janitor/units";
import { Card } from "@/ui/Card";
import { useThemeColors } from "@/theme/colors";

interface UsageBarsProps {
    entries: DiskUsageEntry[];
}

/**
 * Ranked horizontal-bar list of the biggest dev dirs. Each row (rank `n`, 0-based) shows the label +
 * size and a bar whose width is the entry's percentage of the largest entry. Pre-sorted by the
 * backend (bytes desc); we annotate with `pct` via `withPercentOfMax`. Feature-local (Tier-2) — the
 * shared `@/ui/*` primitives stay untouched.
 *
 * testIDs (rank-indexed so Appium can assert ORDER): `disk-janitor-row-<n>` (the Card),
 * `disk-janitor-size-<n>` (the size text), `disk-janitor-bar-<n>` (the filled bar; its width % is
 * read via the `accessibilityValue`/`label` so the test can assert width matches the size order).
 */
export function UsageBars({ entries }: UsageBarsProps) {
    const ranked = withPercentOfMax(entries);

    return (
        <View testID="disk-janitor-bars" className="gap-3">
            {ranked.map((entry, index) => (
                <UsageBar key={entry.path} entry={entry} index={index} />
            ))}
        </View>
    );
}

function UsageBar({ entry, index }: { entry: RankedDiskEntry; index: number }) {
    const c = useThemeColors();
    const sizeLabel = formatBytes(entry.bytes);

    return (
        <Card testID={`disk-janitor-row-${index}`} className="gap-2">
            <View className="flex-row items-center justify-between">
                <Text
                    numberOfLines={1}
                    className="flex-1 pr-2 text-sm"
                    style={{ color: c.textPrimary, fontFamily: "monospace" }}
                >
                    {entry.label}
                </Text>
                <Text
                    testID={`disk-janitor-size-${index}`}
                    className="text-sm font-bold"
                    style={{ color: c.textPrimary, fontFamily: "monospace" }}
                >
                    {sizeLabel}
                </Text>
            </View>

            {/* Bar track + fill. The fill width is `pct`%; we expose the pct + size on the fill's
                accessibilityValue/label so Appium can read the proportional width deterministically. */}
            <View
                accessibilityLabel={`${entry.label} bar track`}
                className="h-2 w-full overflow-hidden rounded-full"
                style={{ backgroundColor: c.border }}
            >
                <View
                    testID={`disk-janitor-bar-${index}`}
                    accessible
                    accessibilityLabel={`${entry.pct}% ${sizeLabel}`}
                    accessibilityValue={{ text: `${entry.pct}` }}
                    className="h-2 rounded-full"
                    style={{ width: `${entry.pct}%`, backgroundColor: c.accent }}
                />
            </View>
        </Card>
    );
}
