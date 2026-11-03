import type { WaitingSessionDto } from "@dd/contract";
import { Pressable, Text, View } from "react-native";
import { DecisionCard } from "@/features/answer-queue/components/DecisionCard";
import { FormCard } from "@/features/answer-queue/components/FormCard";
import { ReceiptLine, WriteError } from "@/features/answer-queue/components/ReceiptLine";
import { useSendStaged } from "@/features/answer-queue/hooks";
import { idempotencyKey, stagedOf } from "@/features/answer-queue/units";
import { Card } from "@/ui/Card";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

/**
 * One agent session of the queue: its title and agent, the notch count, every waiting item, and one Send for every
 * staged pick of the session (one message, as the notch sends it). An agent's own dialog (a plan approval, a
 * permission prompt) is listed so the count adds up, and is answered on the Mac.
 */
export function QueueSessionCard({ session }: { session: WaitingSessionDto }) {
    const c = useThemeColors();
    const send = useSendStaged();
    const key = session.sessionId ?? session.items[0]?.id ?? "form";
    const staged = stagedOf(session).length;
    const testId = `answer-queue-session-${key}`;

    return (
        <Card bezel className="gap-3" testID={testId}>
            <View className="flex-row items-center gap-2">
                <Text className="flex-1 text-sm font-semibold" style={{ color: c.textPrimary }} numberOfLines={1}>
                    {session.title ?? session.project ?? "Agent question"}
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
                        <DecisionCard key={item.id} session={session.sessionId} decision={item} />
                    ) : null;
                }

                if (item.kind === "form") {
                    return <FormCard key={item.id} form={item} />;
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
                    disabled={send.isPending}
                    onPress={() =>
                        send.mutate({
                            session: session.sessionId ?? "",
                            ...(session.provider ? { provider: session.provider } : {}),
                            key: idempotencyKey(),
                        })
                    }
                    className="min-h-11 items-center justify-center rounded-lg px-4"
                    style={{ backgroundColor: c.accent, opacity: send.isPending ? 0.6 : 1 }}
                >
                    <Text className="font-bold" style={{ color: c.bgBase, fontFamily: "monospace" }}>
                        {send.isPending ? "Sending…" : `Send ${staged} staged`}
                    </Text>
                </Pressable>
            ) : null}
            {send.data ? <ReceiptLine testID={`${testId}-receipt`} receipt={send.data} /> : null}
            {send.isError ? <WriteError testID={`${testId}-error`} error={send.error} /> : null}
        </Card>
    );
}
