import type { AgentBoardSession, AgentStopReceiptDto, AgentTranscriptTurnDto } from "@dd/contract";
import { Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    KeyboardAvoidingView,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    Platform,
    Pressable,
    Text,
    type TextStyle,
    View,
} from "react-native";
import { PhaseBadge } from "@/features/agents/components/PhaseBadge";
import { PingButton } from "@/features/agents/components/PingButton";
import { ago } from "@/features/agents/components/SessionCard";
import { SteerComposer } from "@/features/agents/components/SteerComposer";
import { useAgentsBoard, useAgentTranscript, useStopSession } from "@/features/agents/hooks";
import { confirmWithFaceId } from "@/lib/face-id";
import { idempotencyKey } from "@/lib/idempotency";
import { useMinuteClock } from "@/lib/minute-clock";
import { Empty } from "@/ui/Empty";
import { useThemeColors } from "@/theme/colors";

/** How much of one turn's text, or of one tool's output, the view shows before "Show all". */
const TURN_TEXT_CHARS = 1_500;

function clip(text: string): string {
    return text.length > TURN_TEXT_CHARS ? `${text.slice(0, TURN_TEXT_CHARS)}…` : text;
}

/** A text cut to its first `TURN_TEXT_CHARS` characters, with a control that shows the rest and cuts it again. */
function ClippedText({ text, what, testID, style }: { text: string; what: string; testID?: string; style: TextStyle }) {
    const c = useThemeColors();
    const [expanded, setExpanded] = useState(false);
    const long = text.length > TURN_TEXT_CHARS;

    return (
        <>
            <Text testID={testID} selectable style={style}>
                {expanded || !long ? text : clip(text)}
            </Text>
            {long ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={expanded ? `Show less of ${what}` : `Show all of ${what}`}
                    accessibilityState={{ expanded }}
                    onPress={() => setExpanded((value) => !value)}
                >
                    <Text style={{ color: c.accent, fontSize: 12 }}>
                        {expanded ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
                    </Text>
                </Pressable>
            ) : null}
        </>
    );
}

type TranscriptTool = AgentTranscriptTurnDto["tools"][number];

/** One tool call: its name and input; a tap shows what it returned, or the error it failed with. */
function ToolCall({ tool }: { tool: TranscriptTool }) {
    const c = useThemeColors();
    const [open, setOpen] = useState(false);
    const id = tool.id || tool.name;
    const color = tool.isError ? c.danger : c.textSecondary;
    const line = (
        <Text numberOfLines={open ? undefined : 2} style={{ color, fontFamily: "monospace", fontSize: 11 }}>
            {`${tool.name} ${tool.inputPreview}`}
        </Text>
    );

    if (tool.result === null) {
        return line;
    }

    return (
        <View className="gap-1">
            <Pressable
                testID={`tool-${id}`}
                accessibilityRole="button"
                accessibilityLabel={`${tool.isError ? "Failed " : ""}${tool.name} call, ${open ? "hide" : "show"} its output`}
                accessibilityState={{ expanded: open }}
                onPress={() => setOpen((value) => !value)}
            >
                {line}
            </Pressable>
            {open ? (
                <ClippedText
                    testID={`tool-result-${id}`}
                    text={tool.result === "" ? "(no output)" : tool.result}
                    what={`the ${tool.name} output`}
                    style={{ color, fontFamily: "monospace", fontSize: 11 }}
                />
            ) : null}
        </View>
    );
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
                    <ClippedText
                        testID={`turn-text-${turn.id}`}
                        text={turn.text}
                        what="this turn"
                        style={{ color: system ? c.textMuted : c.textPrimary, fontSize: 14 }}
                    />
                ) : null}
                {turn.tools.map((tool) => (
                    <ToolCall key={tool.id || tool.name} tool={tool} />
                ))}
            </View>
        </View>
    );
});

const turnKey = (turn: AgentTranscriptTurnDto, index: number) => turn.id || String(index);
const renderTurn = ({ item }: { item: AgentTranscriptTurnDto }) => <Turn turn={item} />;

/**
 * A stop's answer. The screen holds it, not the Stop button: a stopped session leaves the refetched board, which
 * unmounts the header and its button, and the confirmation must outlive that.
 */
function StopReceipt({ receipt }: { receipt: AgentStopReceiptDto }) {
    const c = useThemeColors();

    return (
        <Text testID="stop-receipt" className="px-4 pt-3" style={{ color: receipt.stopped ? c.accent : c.danger, fontSize: 12 }}>
            {receipt.stopped ? `Stopped (${receipt.signal}).` : `Not stopped: ${receipt.reason ?? "unknown"}`}
        </Text>
    );
}

type OnStopReceipt = (receipt: AgentStopReceiptDto) => void;

function StopButton({ session, onReceipt }: { session: AgentBoardSession; onReceipt: OnStopReceipt }) {
    const c = useThemeColors();
    const stop = useStopSession(onReceipt);
    const pid = session.pid;

    // The destructive confirmation first, then Face ID (F4): a stop ends a process tree and cannot be undone.
    const stopAfterFaceId = async (stopPid: number) => {
        const gate = await confirmWithFaceId("Stop this agent session");

        if (!gate.ok) {
            Alert.alert("Not stopped", gate.reason);
            return;
        }

        stop.mutate({ key: session.key, pid: stopPid, idempotencyKey: idempotencyKey() });
    };

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
                    onPress: () => void stopAfterFaceId(pid),
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
            {stop.isError ? (
                <Text style={{ color: c.danger, fontSize: 12 }}>{`Stop failed: ${String(stop.error)}`}</Text>
            ) : null}
        </View>
    );
}

function SessionHeader({ session, onStopReceipt }: { session: AgentBoardSession; onStopReceipt: OnStopReceipt }) {
    const c = useThemeColors();
    const meta = [session.provider, session.account, session.model].filter(Boolean).join(" · ");
    const now = useMinuteClock(useIsFocused());

    return (
        <View className="gap-2 border-b p-4" style={{ borderColor: c.border }}>
            <View className="flex-row items-center gap-2">
                <PhaseBadge label={session.label} testID="session-phase" />
                <Text numberOfLines={1} className="flex-1" style={{ color: c.textSecondary, fontFamily: "monospace", fontSize: 11 }}>
                    {meta}
                </Text>
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                    {ago(session.lastActivityAt, now)}
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
            <PingButton session={session} />
            <StopButton session={session} onReceipt={onStopReceipt} />
        </View>
    );
}

/** How far from the end, in points, still counts as reading the newest turn. */
const FOLLOW_SLACK_PT = 80;

function Transcript({ session }: { session: AgentBoardSession }) {
    const c = useThemeColors();
    const transcript = useAgentTranscript(session);
    const list = useRef<FlatList<AgentTranscriptTurnDto>>(null);
    // The list follows new turns only while the reader is at the end; a reader scrolled back keeps the place, and a
    // "Newest" button says that more came in.
    const following = useRef(true);
    const [behind, setBehind] = useState(false);
    const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        following.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK_PT;

        if (following.current) {
            setBehind(false);
        }
    }, []);
    const onContentSizeChange = useCallback(() => {
        if (following.current) {
            list.current?.scrollToEnd({ animated: false });
            return;
        }

        setBehind(true);
    }, []);
    const jumpToNewest = useCallback(() => {
        following.current = true;
        setBehind(false);
        list.current?.scrollToEnd({ animated: true });
    }, []);

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
        <View className="flex-1">
            <FlatList
                ref={list}
                testID="session-transcript"
                data={transcript.data.turns}
                keyExtractor={turnKey}
                renderItem={renderTurn}
                onScroll={onScroll}
                scrollEventThrottle={100}
                onContentSizeChange={onContentSizeChange}
                contentContainerClassName="gap-2 p-4"
                ListHeaderComponent={
                    transcript.data.truncated ? (
                        <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11, textAlign: "center" }}>
                            Newest turns only
                        </Text>
                    ) : null
                }
            />
            {behind ? (
                <Pressable
                    testID="transcript-jump-newest"
                    accessibilityRole="button"
                    accessibilityLabel="Jump to the newest turn"
                    onPress={jumpToNewest}
                    className="absolute bottom-3 self-center rounded-full px-3 py-1.5"
                    style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.accentGlow }}
                >
                    <Text style={{ color: c.accent, fontSize: 12, fontWeight: "600" }}>Newest ↓</Text>
                </Pressable>
            ) : null}
        </View>
    );
}

/**
 * One live session (F9, F10, F19): its phase and stuck verdict from the live board, a Stop action that ends its
 * process tree after a confirmation, its newest turns as a chat that tails while the screen is on top, and the steer
 * composer with Esc and Nudge (`SteerComposer`, through the Mac's one session-send module). `?text=` starts the
 * composer with a message (a saved prompt, a transcribed clip).
 */
export default function AgentSessionScreen() {
    const c = useThemeColors();
    const { key, text } = useLocalSearchParams<{ key?: string; text?: string }>();
    const board = useAgentsBoard();
    const session = board.data?.sessions.find((entry) => entry.key === key);
    const timings = board.data?.sendTimings;
    // Kept per session key, so the route's next session does not show the last one's stop.
    const [stop, setStop] = useState<{ key: string; receipt: AgentStopReceiptDto } | null>(null);
    const stopReceipt = stop && stop.key === key ? stop.receipt : null;
    const onStopReceipt = useCallback(
        (receipt: AgentStopReceiptDto) => setStop(key ? { key, receipt } : null),
        [key]
    );

    return (
        <>
            <Stack.Screen options={{ title: session?.project ?? "Session" }} />
            <View testID="screen-agent-session" accessibilityLabel="screen-agent-session" className="flex-1 bg-dd-bg-base">
                {stopReceipt ? <StopReceipt receipt={stopReceipt} /> : null}
                {session ? (
                    // Keyed by the session: the route stays mounted when `key` changes, and the composer's unsent text,
                    // its timing and the transcript's scroll belong to the session they were made for.
                    <KeyboardAvoidingView
                        key={session.key}
                        className="flex-1"
                        behavior={Platform.OS === "ios" ? "padding" : undefined}
                        keyboardVerticalOffset={96}
                    >
                        <SessionHeader session={session} onStopReceipt={onStopReceipt} />
                        <Transcript session={session} />
                        <SteerComposer session={session} timings={timings?.[session.provider]} initialText={text} />
                    </KeyboardAvoidingView>
                ) : board.isPending ? (
                    // "Not live" is a verdict about a board the phone has read; before that it only knows it is reading.
                    <View testID="session-loading" className="flex-1 items-center justify-center">
                        <ActivityIndicator color={c.accent} />
                    </View>
                ) : board.isError && !board.data ? (
                    <Empty testID="session-board-error" title="Could not read the board" hint={String(board.error)} />
                ) : (
                    <Empty testID="session-gone" title="Session not live" hint="It ended on the Mac." />
                )}
            </View>
        </>
    );
}
