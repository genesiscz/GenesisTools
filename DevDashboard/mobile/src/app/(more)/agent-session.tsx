import type { AgentBoardSession, AgentStopReceiptDto, AgentTranscriptTurnDto } from "@dd/contract";
import { Stack, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from "react-native";
import { PhaseBadge } from "@/features/agents/components/PhaseBadge";
import { ago } from "@/features/agents/components/SessionCard";
import { useAgentTranscript, useBoardSession, useStopSession } from "@/features/agents/hooks";
import { idempotencyKey } from "@/features/answer-queue/units";
import { Empty } from "@/ui/Empty";
import { useThemeColors } from "@/theme/colors";

/** How much of one turn's text the view shows; a long reply is cut with a marker. */
const TURN_TEXT_CHARS = 1_500;

function clip(text: string): string {
    return text.length > TURN_TEXT_CHARS ? `${text.slice(0, TURN_TEXT_CHARS)}…` : text;
}

const Turn = memo(function Turn({ turn }: { turn: AgentTranscriptTurnDto }) {
    const c = useThemeColors();
    const mine = turn.role === "user";
    const system = turn.role === "system";

    if (system && turn.text.trim() === "") {
        return null;
    }

    return (
        <View testID={`turn-${turn.id}`} className={mine ? "items-end" : "items-start"}>
            <View
                className="max-w-[88%] gap-1 rounded-2xl px-3 py-2"
                style={{
                    backgroundColor: mine ? c.accentMuted : c.bgPanel,
                    borderWidth: 1,
                    borderColor: mine ? c.accentGlow : c.border,
                }}
            >
                {turn.text.trim() !== "" ? (
                    <Text selectable style={{ color: system ? c.textMuted : c.textPrimary, fontSize: 14 }}>
                        {clip(turn.text)}
                    </Text>
                ) : null}
                {turn.tools.map((tool) => (
                    <Text
                        key={tool.id || tool.name}
                        numberOfLines={2}
                        style={{ color: tool.isError ? c.danger : c.textSecondary, fontFamily: "monospace", fontSize: 11 }}
                    >
                        {`${tool.name} ${tool.inputPreview}`}
                    </Text>
                ))}
            </View>
        </View>
    );
});

const turnKey = (turn: AgentTranscriptTurnDto, index: number) => turn.id || String(index);
const renderTurn = ({ item }: { item: AgentTranscriptTurnDto }) => <Turn turn={item} />;

function StopButton({ session }: { session: AgentBoardSession }) {
    const c = useThemeColors();
    const [receipt, setReceipt] = useState<AgentStopReceiptDto | null>(null);
    const stop = useStopSession(setReceipt);
    const pid = session.pid;

    // Face ID waits for F4 (expo-local-authentication is not a dependency yet); a destructive confirmation stands in.
    const confirm = () => {
        if (pid === null) {
            return;
        }

        Alert.alert(
            "Stop this session?",
            `Ends ${session.project ?? session.provider} (pid ${pid}) and its process tree on the Mac: SIGTERM, then SIGKILL after 5 s.`,
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Stop",
                    style: "destructive",
                    onPress: () => stop.mutate({ key: session.key, pid, idempotencyKey: idempotencyKey() }),
                },
            ]
        );
    };

    return (
        <View className="gap-1">
            <Pressable
                testID="btn-stop-session"
                accessibilityRole="button"
                accessibilityLabel="Stop session"
                disabled={pid === null || stop.isPending}
                onPress={confirm}
                className="items-center rounded-xl py-2"
                style={{ borderWidth: 1, borderColor: c.danger, opacity: pid === null ? 0.4 : 1 }}
            >
                <Text style={{ color: c.danger, fontFamily: "monospace", fontWeight: "700" }}>
                    {stop.isPending ? "Stopping…" : pid === null ? "No process to stop" : `Stop (pid ${pid})`}
                </Text>
            </Pressable>
            {receipt ? (
                <Text testID="stop-receipt" style={{ color: receipt.stopped ? c.accent : c.danger, fontSize: 12 }}>
                    {receipt.stopped ? `Stopped (${receipt.signal}).` : `Not stopped: ${receipt.reason ?? "unknown"}`}
                </Text>
            ) : null}
            {stop.isError ? (
                <Text style={{ color: c.danger, fontSize: 12 }}>{`Stop failed: ${String(stop.error)}`}</Text>
            ) : null}
        </View>
    );
}

function SessionHeader({ session }: { session: AgentBoardSession }) {
    const c = useThemeColors();
    const meta = [session.provider, session.account, session.model].filter(Boolean).join(" · ");

    return (
        <View className="gap-2 border-b p-4" style={{ borderColor: c.border }}>
            <View className="flex-row items-center gap-2">
                <PhaseBadge label={session.label} testID="session-phase" />
                <Text numberOfLines={1} className="flex-1" style={{ color: c.textSecondary, fontFamily: "monospace", fontSize: 11 }}>
                    {meta}
                </Text>
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                    {ago(session.lastActivityAt, Date.now())}
                </Text>
            </View>
            {session.title ? (
                <Text numberOfLines={2} style={{ color: c.textPrimary, fontWeight: "700" }}>
                    {session.title}
                </Text>
            ) : null}
            {session.stuck ? (
                <Text testID="session-stuck" style={{ color: c.danger, fontSize: 12 }}>
                    {`Stuck (${session.stuck.kind}): ${session.stuck.detail}`}
                </Text>
            ) : null}
            <StopButton session={session} />
        </View>
    );
}

function Transcript({ session }: { session: AgentBoardSession }) {
    const c = useThemeColors();
    const transcript = useAgentTranscript(session);
    const list = useRef<FlatList<AgentTranscriptTurnDto>>(null);
    const toEnd = useCallback(() => list.current?.scrollToEnd({ animated: false }), []);

    if (session.sessionId === null) {
        return <Empty testID="transcript-none" title="No transcript" hint="The Mac found this agent by its process only." />;
    }

    if (transcript.isPending) {
        return (
            <View className="flex-1 items-center justify-center">
                <ActivityIndicator color={c.accent} />
            </View>
        );
    }

    if (transcript.isError) {
        return <Empty testID="transcript-error" title="Could not read the transcript" hint={String(transcript.error)} />;
    }

    return (
        <FlatList
            ref={list}
            testID="session-transcript"
            data={transcript.data.turns}
            keyExtractor={turnKey}
            renderItem={renderTurn}
            onContentSizeChange={toEnd}
            contentContainerClassName="gap-2 p-4"
            ListHeaderComponent={
                transcript.data.truncated ? (
                    <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11, textAlign: "center" }}>
                        Newest turns only
                    </Text>
                ) : null
            }
        />
    );
}

/**
 * One live session (F9, F19): its phase and stuck verdict from the live board, a Stop action that ends its process
 * tree after a confirmation, and its newest turns as a chat that tails while the screen is on top. Esc and a nudge
 * prompt wait for the steer route (M5, F10).
 */
export default function AgentSessionScreen() {
    const { key } = useLocalSearchParams<{ key?: string }>();
    const session = useBoardSession(key ?? "");

    return (
        <>
            <Stack.Screen options={{ title: session?.project ?? "Session" }} />
            <View testID="screen-agent-session" accessibilityLabel="screen-agent-session" className="flex-1 bg-dd-bg-base">
                {session ? (
                    <>
                        <SessionHeader session={session} />
                        <Transcript session={session} />
                    </>
                ) : (
                    <Empty testID="session-gone" title="Session not live" hint="It ended, or the board has not loaded it." />
                )}
            </View>
        </>
    );
}
