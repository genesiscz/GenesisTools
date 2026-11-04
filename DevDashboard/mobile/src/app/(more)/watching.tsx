import type { WatchMuteReceiptDto, WatchRowDto, WatchSourceId } from "@dd/contract";
import * as Linking from "expo-linking";
import { Stack } from "expo-router";
import { memo, useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { ago } from "@/features/agents/components/SessionCard";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useMuteWatch, useWatching } from "@/features/watching/hooks";
import { attentionCount, MUTE_MINUTES, rowsOf } from "@/features/watching/queries";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

const rowKey = (row: WatchRowDto) => `${row.source}:${row.id}`;

const WatchRow = memo(function WatchRow({ row, now }: { row: WatchRowDto; now: number }) {
    const c = useThemeColors();
    const [receipt, setReceipt] = useState<WatchMuteReceiptDto | null>(null);
    const mute = useMuteWatch(setReceipt);
    const tone = row.state === "down" ? c.danger : row.state === "alert" ? c.warning : row.state === "ok" ? c.accent : c.textMuted;
    const changed = row.changedAt ? ago(Date.parse(row.changedAt), now) : "";

    return (
        <View
            testID={`watch-${row.source}-${row.id}`}
            className="gap-1.5 rounded-2xl p-4"
            style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: row.state === "down" ? c.danger : c.border }}
        >
            <View className="flex-row items-center gap-2">
                <Text style={{ color: tone, fontFamily: "monospace", fontSize: 11 }}>{row.mutedUntil ? `${row.state} · muted` : row.state}</Text>
                <Text numberOfLines={1} className="flex-1" style={{ color: c.textPrimary, fontWeight: "600" }}>
                    {row.title}
                </Text>
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>{changed}</Text>
            </View>
            <Text numberOfLines={2} style={{ color: c.textSecondary, fontSize: 13 }}>
                {row.detail}
            </Text>
            <View className="flex-row items-center gap-4 pt-1">
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>{row.source}</Text>
                {row.link ? (
                    <Pressable accessibilityRole="link" hitSlop={8} onPress={() => void Linking.openURL(row.link ?? "")}>
                        <Text style={{ color: c.accent, fontSize: 13 }}>Open</Text>
                    </Pressable>
                ) : null}
                {row.canMute ? (
                    <Pressable
                        testID={`watch-mute-${row.source}-${row.id}`}
                        accessibilityRole="button"
                        hitSlop={8}
                        disabled={mute.isPending}
                        onPress={() =>
                            mute.mutate({
                                source: row.source,
                                id: row.id,
                                minutes: row.mutedUntil ? 0 : MUTE_MINUTES,
                                idempotencyKey: idempotencyKey(),
                            })
                        }
                    >
                        <Text style={{ color: c.accent, fontSize: 13 }}>{row.mutedUntil ? "Unmute" : "Mute 2 h"}</Text>
                    </Pressable>
                ) : null}
            </View>
            {receipt ? <Text style={{ color: c.textMuted, fontSize: 12 }}>{receipt.detail}</Text> : null}
        </View>
    );
});

/**
 * One Watching screen (F30): every watch on the Mac in one list (Monitor watchers, with the Alza watchdogs and other
 * item sources it runs, watched domains, shop favorites and TradingView alerts), outages and alerts first. A source
 * without rows says why. Mute 2 h silences a Monitor watcher on the Mac.
 */
export default function WatchingScreen() {
    const c = useThemeColors();
    const watching = useWatching();
    const [source, setSource] = useState<WatchSourceId | "all">("all");
    const now = Date.now();
    const rows = rowsOf(watching.data, source);
    const notes = (watching.data?.sources ?? []).filter((entry) => entry.note && (source === "all" || entry.id === source));
    const renderItem = useCallback(({ item }: { item: WatchRowDto }) => <WatchRow row={item} now={now} />, [now]);
    const chips: Array<{ id: WatchSourceId | "all"; label: string }> = [
        { id: "all", label: "All" },
        ...(watching.data?.sources ?? []).map((entry) => ({ id: entry.id, label: `${entry.label} ${entry.count}` })),
    ];
    const attention = attentionCount(watching.data?.rows ?? []);

    return (
        <>
            <Stack.Screen options={{ title: "Watching" }} />
            <FlatList
                testID="screen-watching"
                accessibilityLabel="screen-watching"
                className="flex-1 bg-dd-bg-base"
                data={rows}
                keyExtractor={rowKey}
                renderItem={renderItem}
                contentInsetAdjustmentBehavior="automatic"
                contentContainerClassName="gap-3 p-4"
                refreshControl={
                    <RefreshControl refreshing={watching.isRefetching} onRefresh={() => void watching.refetch()} tintColor={c.accent} />
                }
                ListHeaderComponent={
                    <View className="gap-2 pb-1">
                        <View className="flex-row flex-wrap items-center gap-2">
                            <StatusPill label={attention > 0 ? `${attention} need a look` : "All quiet"} tone={attention > 0 ? "danger" : "muted"} normalCase />
                            <MockBadge />
                        </View>
                        <View className="flex-row flex-wrap gap-2">
                            {chips.map((chip) => (
                                <Pressable
                                    key={chip.id}
                                    testID={`watch-source-${chip.id}`}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: chip.id === source }}
                                    onPress={() => setSource(chip.id)}
                                    className="rounded-full px-3 py-1"
                                    style={{
                                        backgroundColor: chip.id === source ? c.accentMuted : c.bgPanel,
                                        borderWidth: 1,
                                        borderColor: chip.id === source ? c.accentGlow : c.border,
                                    }}
                                >
                                    <Text style={{ color: chip.id === source ? c.accent : c.textSecondary, fontSize: 12 }}>{chip.label}</Text>
                                </Pressable>
                            ))}
                        </View>
                        {notes.map((entry) => (
                            <Text key={entry.id} style={{ color: c.textMuted, fontSize: 12 }}>{`${entry.label}: ${entry.note}`}</Text>
                        ))}
                        {watching.isError ? <Text style={{ color: c.danger }}>{String(watching.error)}</Text> : null}
                    </View>
                }
                ListEmptyComponent={watching.isPending ? null : <Empty title="Nothing watched here" hint="Add a watch on the Mac." />}
            />
        </>
    );
}
