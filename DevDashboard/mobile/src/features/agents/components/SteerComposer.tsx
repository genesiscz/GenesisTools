import type {
    AgentBoardSession,
    AgentInterruptReceiptDto,
    AgentSendOutcome,
    AgentSendTiming,
    AgentSendTimingSupport,
} from "@dd/contract";
import { useEffect, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { type SteerResult, useInterruptSession, useSteerComposer } from "@/features/agents/hooks";
import { getPref, setPref } from "@/lib/storage/kv";
import { type ThemeColors, useThemeColors } from "@/theme/colors";

/** The Nudge button's text until the user saves their own (`dd.nudgePrompt`). */
export const DEFAULT_NUDGE =
    "You look stuck. In one line, say what you are waiting for or what failed, then continue with the next step.";

/** The timing chips, in the order the composer shows them. */
export const TIMING_CHIPS: Record<AgentSendTiming, { word: string; testID: string }> = {
    now: { word: "Now", testID: "timing-now" },
    "next-turn": { word: "Next turn", testID: "timing-next-turn" },
    later: { word: "Later", testID: "timing-later" },
};

/** The words and colour of each outcome. Exhaustive, so a new outcome fails to compile until it has a row. */
export const OUTCOME_LINES: Record<AgentSendOutcome, { word: string; tone: "ok" | "wait" | "bad" }> = {
    delivered: { word: "Delivered", tone: "ok" },
    "queued-daemon": { word: "Queued for the next turn", tone: "wait" },
    "queued-session": { word: "Saved for the session", tone: "wait" },
    refused: { word: "Not sent", tone: "bad" },
    unknown: { word: "Unknown: check the session before you send again", tone: "bad" },
};

function toneColor(tone: "ok" | "wait" | "bad", c: ThemeColors): string {
    const colors = { ok: c.accent, wait: c.warning, bad: c.danger };
    return colors[tone];
}

function ResultLine({ result }: { result: SteerResult }) {
    const c = useThemeColors();

    if (result.kind === "waiting") {
        return (
            <Text testID="steer-result" style={{ color: c.warning, fontSize: 12 }}>
                Offline: kept on the phone, sent when the Mac is reachable.
            </Text>
        );
    }

    if (result.kind === "failed") {
        return (
            <Text testID="steer-result" style={{ color: c.danger, fontSize: 12 }}>
                {`Failed: ${result.error}`}
            </Text>
        );
    }

    const line = OUTCOME_LINES[result.receipt.outcome];
    return (
        <Text testID="steer-result" style={{ color: toneColor(line.tone, c), fontSize: 12 }}>
            {`${line.word} · ${result.receipt.route}: ${result.receipt.detail}`}
        </Text>
    );
}

function TimingChips({
    timings,
    timing,
    onPick,
}: {
    timings: Record<AgentSendTiming, AgentSendTimingSupport> | undefined;
    timing: AgentSendTiming;
    onPick: (timing: AgentSendTiming) => void;
}) {
    const c = useThemeColors();

    return (
        <View className="flex-row gap-2" accessibilityRole="radiogroup">
            {(Object.keys(TIMING_CHIPS) as AgentSendTiming[]).map((option) => {
                const support = timings?.[option];
                const supported = support?.supported !== false;
                const picked = option === timing;
                return (
                    <Pressable
                        key={option}
                        testID={TIMING_CHIPS[option].testID}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: picked, disabled: !supported }}
                        accessibilityLabel={`${TIMING_CHIPS[option].word}${supported ? "" : ", not available"}`}
                        onPress={() => {
                            if (support && !support.supported) {
                                Alert.alert(`${TIMING_CHIPS[option].word} is not available`, support.reason);
                                return;
                            }

                            onPick(option);
                        }}
                        className="rounded-full px-3 py-1.5"
                        style={{
                            borderWidth: 1,
                            borderColor: picked ? c.accent : c.border,
                            backgroundColor: picked ? c.accentMuted : "transparent",
                            opacity: supported ? 1 : 0.4,
                        }}
                    >
                        <Text style={{ color: picked ? c.accent : c.textSecondary, fontSize: 12, fontWeight: "600" }}>
                            {TIMING_CHIPS[option].word}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

function RescueRow({ session, onNudge }: { session: AgentBoardSession; onNudge: () => void }) {
    const c = useThemeColors();
    const [receipt, setReceipt] = useState<AgentInterruptReceiptDto | null>(null);
    const esc = useInterruptSession(setReceipt);

    return (
        <View className="gap-1">
            <View className="flex-row gap-2">
                <Pressable
                    testID="btn-esc-session"
                    accessibilityRole="button"
                    accessibilityLabel="Press Escape in the session"
                    accessibilityHint="Ends the running turn; the session stays open"
                    disabled={esc.isPending || session.sessionId === null}
                    onPress={() => esc.mutate(session.key)}
                    className="flex-1 items-center rounded-xl py-2"
                    style={{ borderWidth: 1, borderColor: c.warning, opacity: session.sessionId === null ? 0.4 : 1 }}
                >
                    <Text style={{ color: c.warning, fontFamily: "monospace", fontWeight: "700" }}>
                        {esc.isPending ? "Esc…" : "Esc"}
                    </Text>
                </Pressable>
                <Pressable
                    testID="btn-nudge-session"
                    accessibilityRole="button"
                    accessibilityLabel="Nudge"
                    accessibilityHint="Puts your nudge prompt in the composer"
                    onPress={onNudge}
                    className="flex-1 items-center rounded-xl py-2"
                    style={{ borderWidth: 1, borderColor: c.accentGlow }}
                >
                    <Text style={{ color: c.accent, fontFamily: "monospace", fontWeight: "700" }}>Nudge</Text>
                </Pressable>
            </View>
            {receipt ? (
                <Text testID="esc-receipt" style={{ color: receipt.outcome === "sent" ? c.accent : c.danger, fontSize: 12 }}>
                    {receipt.outcome === "sent" ? `Esc sent: ${receipt.detail}` : `Esc ${receipt.outcome}: ${receipt.detail}`}
                </Text>
            ) : null}
            {esc.isError ? (
                <Text style={{ color: c.danger, fontSize: 12 }}>{`Esc failed: ${String(esc.error)}`}</Text>
            ) : null}
        </View>
    );
}

/**
 * The steer composer of one live session (F10) with the rescue row (F19): Esc ends the running turn, Nudge puts the
 * saved nudge prompt in the composer. A timing the session's harness cannot keep is greyed and says why when tapped.
 * A message the Mac cannot be reached for waits on the phone and is sent with the same key on reconnect.
 */
export function SteerComposer({
    session,
    timings,
    initialText,
}: {
    session: AgentBoardSession;
    timings: Record<AgentSendTiming, AgentSendTimingSupport> | undefined;
    /** Text to start with (a saved prompt, a transcribed clip). */
    initialText?: string;
}) {
    const c = useThemeColors();
    const composer = useSteerComposer(session.key);
    const [text, setText] = useState(initialText ?? "");
    const [timing, setTiming] = useState<AgentSendTiming>("now");
    const [nudge, setNudge] = useState(DEFAULT_NUDGE);

    useEffect(() => {
        void getPref("dd.nudgePrompt").then((saved) => {
            if (saved) {
                setNudge(saved);
            }
        });
    }, []);

    useEffect(() => {
        if (initialText) {
            setText(initialText);
        }
    }, [initialText]);

    const canSend = text.trim() !== "" && session.sessionId !== null && !composer.sending;

    return (
        <View testID="steer-composer" className="gap-2 border-t p-3" style={{ borderColor: c.border }}>
            <RescueRow session={session} onNudge={() => setText(nudge)} />
            <TimingChips timings={timings} timing={timing} onPick={setTiming} />
            <View className="flex-row items-end gap-2">
                <TextInput
                    testID="steer-input"
                    accessibilityLabel="Message to the session"
                    value={text}
                    onChangeText={setText}
                    placeholder={session.sessionId === null ? "This session has no id to send to" : "Message the agent"}
                    placeholderTextColor={c.textMuted}
                    multiline
                    editable={session.sessionId !== null}
                    className="flex-1 rounded-xl px-3 py-2"
                    style={{
                        color: c.textPrimary,
                        borderWidth: 1,
                        borderColor: c.border,
                        backgroundColor: c.bgPanel,
                        maxHeight: 120,
                        fontSize: 14,
                    }}
                />
                <Pressable
                    testID="btn-steer-send"
                    accessibilityRole="button"
                    accessibilityLabel="Send"
                    disabled={!canSend}
                    onPress={() => {
                        const message = text.trim();
                        void composer.submit(message, timing).then(() => setText(""));
                    }}
                    className="items-center justify-center rounded-xl px-4 py-2"
                    style={{ backgroundColor: canSend ? c.accent : c.accentMuted }}
                >
                    <Text style={{ color: canSend ? c.bgBase : c.textMuted, fontWeight: "700" }}>
                        {composer.sending ? "…" : "Send"}
                    </Text>
                </Pressable>
            </View>
            {text.trim() !== "" && text !== nudge ? (
                <Pressable
                    testID="btn-save-nudge"
                    accessibilityRole="button"
                    onPress={() => {
                        setNudge(text);
                        void setPref("dd.nudgePrompt", text);
                    }}
                >
                    <Text style={{ color: c.textMuted, fontSize: 11 }}>Save this text as my nudge</Text>
                </Pressable>
            ) : null}
            {composer.result ? <ResultLine result={composer.result} /> : null}
            {composer.drafts.map((draft) => (
                <View key={draft.id} testID={`steer-draft-${draft.id}`} className="flex-row items-center gap-2">
                    <Text numberOfLines={1} className="flex-1" style={{ color: c.warning, fontSize: 12 }}>
                        {`Waiting (${TIMING_CHIPS[draft.timing].word}): ${draft.text}`}
                    </Text>
                    <Pressable accessibilityRole="button" onPress={() => void composer.discard(draft.id)}>
                        <Text style={{ color: c.textMuted, fontSize: 12 }}>Discard</Text>
                    </Pressable>
                </View>
            ))}
        </View>
    );
}
