import { Stack } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { type PrLine, PrRow } from "@/features/prs/components/PrRow";
import { usePrTriage } from "@/features/prs/hooks";
import { useThemeColors } from "@/theme/colors";
import { Empty } from "@/ui/Empty";

/**
 * PR triage (F20): every open PR of the Mac's configured projects with its readiness (ready badge, unresolved
 * threads, CI), ready ones first. A PR opens to its failing step's log tail, Fix with agent (its threads or the
 * failed check go to the session that owns the PR) and a merge through `tools github merge` after Face ID. A merge
 * receipt stays at the top until dismissed, since the merged PR leaves the list of open PRs.
 */
export default function PrsScreen() {
    const c = useThemeColors();
    const [mine, setMine] = useState(false);
    const [open, setOpen] = useState<string | null>(null);
    const triage = usePrTriage(mine);
    const [merges, setMerges] = useState<(PrLine & { id: number })[]>([]);
    const onMergeLine = useCallback((line: PrLine) => {
        setMerges((current) => [{ ...line, id: Date.now() }, ...current]);
    }, []);

    return (
        <>
            <Stack.Screen options={{ title: "PR triage" }} />
            <View testID="screen-prs" accessibilityLabel="screen-prs" className="flex-1 bg-dd-bg-base">
                <View className="flex-row gap-2 px-4 pt-3">
                    {[false, true].map((value) => (
                        <Pressable
                            key={String(value)}
                            testID={value ? "prs-filter-mine" : "prs-filter-all"}
                            accessibilityRole="button"
                            accessibilityState={{ selected: mine === value }}
                            onPress={() => setMine(value)}
                            className="rounded-full px-3 py-1.5"
                            style={{ borderWidth: 1, borderColor: mine === value ? c.accent : c.border }}
                        >
                            <Text style={{ color: mine === value ? c.accent : c.textSecondary, fontSize: 12 }}>
                                {value ? "Mine" : "All"}
                            </Text>
                        </Pressable>
                    ))}
                </View>
                {merges.map((merge) => (
                    <View key={merge.id} testID="pr-merge-receipt" className="mx-4 mt-2 flex-row items-center gap-3">
                        <Text className="flex-1" style={{ color: merge.ok ? c.accent : c.danger, fontSize: 12 }}>
                            {merge.text}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Dismiss the merge receipt"
                            hitSlop={8}
                            onPress={() => setMerges((current) => current.filter((entry) => entry.id !== merge.id))}
                        >
                            <Text style={{ color: c.textMuted, fontSize: 12 }}>Dismiss</Text>
                        </Pressable>
                    </View>
                ))}
                {triage.isPending ? (
                    <ActivityIndicator style={{ marginTop: 24 }} color={c.accent} />
                ) : triage.isError ? (
                    <Empty testID="prs-error" title="Could not read the PRs" hint={String(triage.error)} />
                ) : (
                    <FlatList
                        testID="prs-list"
                        data={triage.data.prs}
                        keyExtractor={(pr) => pr.url}
                        renderItem={({ item }) => (
                            <PrRow
                                pr={item}
                                open={open === item.url}
                                onToggle={() => setOpen(open === item.url ? null : item.url)}
                                onMergeLine={onMergeLine}
                            />
                        )}
                        contentContainerClassName="gap-2 p-4"
                        onRefresh={() => void triage.refetch()}
                        refreshing={triage.isRefetching}
                        ListEmptyComponent={<Empty testID="prs-none" title="No open PRs" hint="Nothing waits in the configured projects." />}
                        ListFooterComponent={
                            triage.data.skipped.length > 0 ? (
                                <Text style={{ color: c.warning, fontSize: 11 }}>
                                    {`Not read: ${triage.data.skipped.map((entry) => `${entry.what} (${entry.reason})`).join(", ")}`}
                                </Text>
                            ) : null
                        }
                    />
                )}
            </View>
        </>
    );
}

