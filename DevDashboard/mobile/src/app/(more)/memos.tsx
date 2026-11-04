import type { MemoActionKind, MemoActReceiptDto, MemoDto } from "@dd/contract";
import { Stack } from "expo-router";
import { memo as memoize, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useAgentsBoard } from "@/features/agents/hooks";
import { useActOnMemo, useMemos } from "@/features/memos/hooks";
import { ACTION_LABELS, offeredActions } from "@/features/memos/queries";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { useThemeColors } from "@/theme/colors";

const MemoCard = memoize(function MemoCard({ memo }: { memo: MemoDto }) {
    const c = useThemeColors();
    const act = useActOnMemo();
    const board = useAgentsBoard();
    const [receipt, setReceipt] = useState<MemoActReceiptDto | null>(null);
    const [picking, setPicking] = useState(false);
    const run = (action: MemoActionKind, sessionKey?: string) =>
        act.mutate({ id: memo.id, action, sessionKey }, { onSuccess: setReceipt });

    return (
        <View testID={`memo-${memo.id}`} className="gap-2 rounded-2xl p-4" style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border }}>
            <View className="flex-row items-center gap-2">
                <Text numberOfLines={1} className="flex-1" style={{ color: c.textPrimary, fontWeight: "600" }}>
                    {memo.title}
                </Text>
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                    {new Date(memo.recordedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                </Text>
            </View>
            {memo.todos.map((todo) => (
                <Text key={todo} style={{ color: c.textSecondary, fontSize: 13 }}>{`☐ ${todo}`}</Text>
            ))}
            <Text numberOfLines={4} style={{ color: c.textSecondary, fontSize: 13 }}>
                {memo.note}
            </Text>
            {memo.agentTask ? <Text style={{ color: c.accent, fontSize: 13 }}>{`› ${memo.agentTask}`}</Text> : null}
            <View className="flex-row flex-wrap gap-2 pt-1">
                {offeredActions(memo).map((action) => {
                    const done = memo.done[action];

                    return (
                        <Pressable
                            key={action}
                            testID={`memo-${action}-${memo.id}`}
                            accessibilityRole="button"
                            disabled={Boolean(done) || act.isPending}
                            onPress={() => (action === "agent" ? setPicking((open) => !open) : run(action))}
                            className="rounded-full px-3 py-1.5"
                            style={{ backgroundColor: done ? "transparent" : c.accentMuted, borderWidth: 1, borderColor: c.border, opacity: done ? 0.5 : 1 }}
                        >
                            <Text style={{ color: done ? c.textMuted : c.accent, fontSize: 12 }}>{done ? `${ACTION_LABELS[action]} ✓` : ACTION_LABELS[action]}</Text>
                        </Pressable>
                    );
                })}
            </View>
            {picking ? (
                <View className="gap-1">
                    {(board.data?.sessions ?? []).slice(0, 8).map((session) => (
                        <Pressable
                            key={session.key}
                            accessibilityRole="button"
                            onPress={() => {
                                setPicking(false);
                                run("agent", session.key);
                            }}
                            className="rounded-xl px-3 py-2"
                            style={{ borderWidth: 1, borderColor: c.border }}
                        >
                            <Text numberOfLines={1} style={{ color: c.textPrimary, fontSize: 13 }}>
                                {`${session.project ?? session.provider} · ${session.title ?? session.label}`}
                            </Text>
                        </Pressable>
                    ))}
                    {board.data?.sessions.length === 0 ? <Text style={{ color: c.textMuted, fontSize: 12 }}>No live session.</Text> : null}
                </View>
            ) : null}
            {receipt ? <Text style={{ color: receipt.ok ? c.textMuted : c.danger, fontSize: 12 }}>{receipt.detail}</Text> : null}
            {act.isError ? <Text style={{ color: c.danger, fontSize: 12 }}>{String(act.error)}</Text> : null}
        </View>
    );
});

const memoKey = (memo: MemoDto) => memo.id;
const renderMemo = ({ item }: { item: MemoDto }) => <MemoCard memo={item} />;

/**
 * Memo to action (F28): each iPhone Voice Memo the Mac transcribed, split into todos, a note and a task for an agent.
 * Each action runs once: the todos into Reminders, the note into today's vault inbox note, the task into a session.
 */
export default function MemosScreen() {
    const c = useThemeColors();
    const memos = useMemos();

    return (
        <>
            <Stack.Screen options={{ title: "Memos" }} />
            <FlatList
                testID="screen-memos"
                accessibilityLabel="screen-memos"
                className="flex-1 bg-dd-bg-base"
                data={memos.data?.memos ?? []}
                keyExtractor={memoKey}
                renderItem={renderMemo}
                contentInsetAdjustmentBehavior="automatic"
                contentContainerClassName="gap-3 p-4"
                ListHeaderComponent={
                    <View className="gap-1 pb-1">
                        <MockBadge />
                        {memos.isError ? <Text style={{ color: c.danger }}>{String(memos.error)}</Text> : null}
                    </View>
                }
                ListEmptyComponent={
                    memos.isPending ? null : (
                        <Empty
                            title="No memos yet"
                            hint={memos.data?.primedAt ? "Record a Voice Memo; it shows here once iCloud brings it to the Mac." : "The Mac has not scanned Voice Memos yet (tools hub memos install)."}
                        />
                    )
                }
            />
        </>
    );
}
