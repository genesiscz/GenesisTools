import type { AgentBoardSession } from "@dd/contract";
import { router, Stack } from "expo-router";
import { useCallback } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SessionCard } from "@/features/agents/components/SessionCard";
import { useAgentsBoard } from "@/features/agents/hooks";
import { useLiveChannel } from "@/live/provider";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

const keyOf = (session: AgentBoardSession) => session.key;

/**
 * The agents board (F9): every running Claude, Codex and Grok session on the Mac, needs-attention first, with its
 * phase badge, project, account, model, newest prompt and folded sub-agents. The live `agents` channel keeps the
 * phases current; a tap opens the session's transcript.
 */
export default function AgentsScreen() {
    const c = useThemeColors();
    const board = useAgentsBoard();
    const live = useLiveChannel("agents");
    const now = Date.now();
    const open = useCallback((key: string) => {
        router.push({ pathname: "/agent-session", params: { key } });
    }, []);
    const renderItem = useCallback(
        ({ item }: { item: AgentBoardSession }) => <SessionCard session={item} now={now} onOpen={open} />,
        [now, open]
    );
    const sessions = board.data?.sessions ?? [];
    const attention = sessions.filter((s) => s.stalled || s.label === "waiting" || s.label === "interrupted").length;

    return (
        <>
            <Stack.Screen
                options={{
                    title: "Agents",
                    headerRight: () => (
                        <Pressable
                            testID="agents-new"
                            accessibilityRole="button"
                            accessibilityLabel="Start a new agent"
                            hitSlop={12}
                            onPress={() => router.push("/agent-new")}
                        >
                            <Text style={{ color: c.accent, fontSize: 16 }}>New</Text>
                        </Pressable>
                    ),
                }}
            />
            <View testID="screen-agents" accessibilityLabel="screen-agents" className="flex-1 bg-dd-bg-base">
                {board.isPending ? (
                    <View testID="agents-loading" className="flex-1 items-center justify-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Reading live sessions…</Text>
                    </View>
                ) : board.isError ? (
                    <View className="flex-1 items-center justify-center gap-2 p-6">
                        <Text testID="agents-error" style={{ color: c.danger, fontFamily: "monospace" }}>
                            Could not read the agents board.
                        </Text>
                        <Text style={{ color: c.textMuted, textAlign: "center" }}>{String(board.error)}</Text>
                    </View>
                ) : (
                    <FlatList
                        data={sessions}
                        keyExtractor={keyOf}
                        renderItem={renderItem}
                        contentInsetAdjustmentBehavior="automatic"
                        contentContainerClassName="gap-3 p-4"
                        refreshControl={
                            <RefreshControl
                                refreshing={board.isRefetching}
                                onRefresh={() => void board.refetch()}
                                tintColor={c.accent}
                            />
                        }
                        ListHeaderComponent={
                            <View className="flex-row flex-wrap items-center gap-2 pb-1">
                                <StatusPill
                                    testID="agents-live"
                                    label={live ? "Live" : "Polling"}
                                    tone={live ? "accent" : "muted"}
                                    dot={live}
                                    normalCase
                                />
                                <StatusPill label={`${sessions.length} running`} tone="muted" normalCase />
                                {attention > 0 ? (
                                    <StatusPill label={`${attention} need you`} tone="danger" normalCase />
                                ) : null}
                                <MockBadge />
                            </View>
                        }
                        ListEmptyComponent={
                            <Empty testID="agents-empty" title="No live sessions" hint="No Claude, Codex or Grok session runs on the Mac." />
                        }
                    />
                )}
            </View>
        </>
    );
}
