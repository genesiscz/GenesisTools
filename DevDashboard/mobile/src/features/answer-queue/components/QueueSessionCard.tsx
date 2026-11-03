import type { WaitingSessionDto } from "@dd/contract";
import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { DecisionCard } from "@/features/answer-queue/components/DecisionCard";
import { FormCard } from "@/features/answer-queue/components/FormCard";
import { WriteError } from "@/features/answer-queue/components/ReceiptLine";
import { useSendStaged } from "@/features/answer-queue/hooks";
import {
    flushThenSend,
    idempotencyKey,
    type RecentReceipt,
    singleFlight,
    stagedOf,
} from "@/features/answer-queue/units";
import { Card } from "@/ui/Card";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

/**
 * One agent session of the queue: its title and agent, the notch count, every waiting item, and one Send for every
 * staged pick of the session (one message, as the notch sends it). An agent's own dialog (a plan approval, a
 * permission prompt) is listed so the count adds up, and is answered on the Mac.
 */
export function QueueSessionCard({
    session,
    onReceipt,
}: {
    session: WaitingSessionDto;
    /** Keeps a send's receipt above the queue, where it outlives this card. */
    onReceipt: (entry: RecentReceipt) => void;
}) {
    const c = useThemeColors();
    const key = session.sessionId ?? session.items[0]?.id ?? "form";
    const testId = `answer-queue-session-${key}`;
    const label = session.title ?? session.project ?? "Agent question";
    const send = useSendStaged((receipt) => onReceipt({ testID: `${testId}-receipt`, label, receipt }));
    const staged = stagedOf(session).length;
    // Each decision card's flush, by number: Send saves every note being typed and waits for stages first.
    const flushes = useRef(new Map<number, () => Promise<void>>());
    const registerFlush = useCallback((number: number, flush: (() => Promise<void>) | null) => {
        if (flush) {
            flushes.current.set(number, flush);
        } else {
            flushes.current.delete(number);
        }
    }, []);
    // The whole flush-and-send is one guarded operation: taps during the flush do nothing, and the key is made once.
    const once = useRef(singleFlight()).current;
    const [flushing, setFlushing] = useState(false);
    const busy = flushing || send.isPending;
    const sendAll = () =>
        void once(async () => {
            setFlushing(true);
            const action = {
                session: session.sessionId ?? "",
                ...(session.provider ? { provider: session.provider } : {}),
                key: idempotencyKey(),
            };

            try {
                await flushThenSend(flushes.current.values(), () => send.mutate(action));
            } finally {
                setFlushing(false);
            }
        });

    return (
        <Card bezel className="gap-3" testID={testId}>
            <View className="flex-row items-center gap-2">
                <Text className="flex-1 text-sm font-semibold" style={{ color: c.textPrimary }} numberOfLines={1}>
                    {label}
                </Text>
                {session.provider ? <StatusPill label={session.provider} tone="muted" normalCase /> : null}
                <StatusPill testID={`${testId}-count`} label={`${session.counted}`} tone="accent" normalCase />
            </View>
            {session.project && session.title ? (
                <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {session.project}
                </Text>
            ) : null}
            {session.items.map((item) => {
                if (item.kind === "decision") {
                    return session.sessionId ? (
                        <DecisionCard
                            key={item.id}
                            session={session.sessionId}
                            decision={item}
                            registerFlush={registerFlush}
                        />
                    ) : null;
                }

                if (item.kind === "form") {
                    return <FormCard key={item.id} form={item} onReceipt={onReceipt} />;
                }

                return (
                    <View key={item.id} className="gap-1 rounded-lg border border-dd-border p-3">
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            {`${item.title} · answer on the Mac`}
                        </Text>
                        <Text className="text-sm" style={{ color: c.textPrimary }}>
                            {item.prompt}
                        </Text>
                    </View>
                );
            })}
            {session.sessionId && staged > 0 ? (
                <Pressable
                    testID={`${testId}-send`}
                    accessibilityRole="button"
                    accessibilityLabel={`Send ${staged} staged ${staged === 1 ? "pick" : "picks"}`}
                    disabled={busy}
                    onPress={sendAll}
                    className="min-h-11 items-center justify-center rounded-lg px-4"
                    style={{ backgroundColor: c.accent, opacity: busy ? 0.6 : 1 }}
                >
                    <Text className="font-bold" style={{ color: c.bgBase, fontFamily: "monospace" }}>
                        {busy ? "Sending…" : `Send ${staged} staged`}
                    </Text>
                </Pressable>
            ) : null}
            {send.isError ? <WriteError testID={`${testId}-error`} error={send.error} /> : null}
        </Card>
    );
}
