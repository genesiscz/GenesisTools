import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useMacHealth, useSendWake, useWakeRelay } from "@/features/wake/hooks";
import { WAKE_PATIENCE_MS } from "@/features/wake/queries";
import { MockBadge } from "@/ui/MockBadge";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

/**
 * Wake my Mac (F26): one button posts the wakeup relay's `/wake` for this Mac (the relay runs on an always-on machine
 * on the Mac's LAN and sends the magic packet), then the screen asks the Mac's health route every 3 s and turns green
 * when it answers. The relay address and login are kept from the last time the Mac was awake.
 */
export default function WakeScreen() {
    const c = useThemeColors();
    const { relay, fromMac, isPending } = useWakeRelay();
    const wake = useSendWake();
    const [sentAt, setSentAt] = useState<number | null>(null);
    const waiting = sentAt !== null && Date.now() - sentAt < WAKE_PATIENCE_MS;
    const health = useMacHealth(waiting);
    const awake = health.isSuccess && (sentAt === null || health.dataUpdatedAt > sentAt);

    useEffect(() => {
        if (awake) {
            setSentAt(null);
        }
    }, [awake]);

    const status = awake ? "Awake" : waiting ? "Waking…" : health.isError ? "Not answering" : "Checking…";
    const tone = awake ? "accent" : health.isError || waiting ? "danger" : "muted";

    return (
        <>
            <Stack.Screen options={{ title: "Wake my Mac" }} />
            <ScrollView
                testID="screen-wake"
                accessibilityLabel="screen-wake"
                className="flex-1 bg-dd-bg-base"
                contentInsetAdjustmentBehavior="automatic"
                contentContainerClassName="gap-4 p-4"
            >
                <View className="flex-row flex-wrap items-center gap-2">
                    <StatusPill testID="wake-status" label={status} tone={tone} dot={awake} normalCase />
                    <MockBadge />
                </View>
                {isPending ? (
                    <ActivityIndicator color={c.accent} />
                ) : (
                    <View className="gap-1">
                        <Text style={{ color: c.textSecondary, fontSize: 13 }}>
                            {relay?.url ? `Relay ${relay.url}` : "No relay known yet."}
                        </Text>
                        <Text style={{ color: c.textMuted, fontSize: 12 }}>
                            {fromMac ? "Read from the Mac just now." : relay ? "Kept from the last time the Mac answered." : ""}
                        </Text>
                        {relay?.note ? <Text style={{ color: c.warning, fontSize: 12 }}>{relay.note}</Text> : null}
                    </View>
                )}
                <Pressable
                    testID="wake-send"
                    accessibilityRole="button"
                    disabled={wake.isPending || !relay?.configured}
                    onPress={() =>
                        wake.mutate(relay, {
                            onSuccess: (outcome) => {
                                if (outcome.sent) {
                                    setSentAt(Date.now());
                                }
                            },
                        })
                    }
                    className="items-center rounded-xl py-3"
                    style={{ backgroundColor: c.accent, opacity: wake.isPending || !relay?.configured ? 0.4 : 1 }}
                >
                    <Text style={{ color: c.bgBase, fontWeight: "700" }}>{wake.isPending ? "Sending…" : "Wake my Mac"}</Text>
                </Pressable>
                {wake.data ? (
                    <Text testID="wake-outcome" style={{ color: wake.data.sent ? c.textSecondary : c.danger, fontSize: 13 }}>
                        {wake.data.detail}
                    </Text>
                ) : null}
                {sentAt !== null && !waiting && !awake ? (
                    <Text style={{ color: c.danger, fontSize: 13 }}>
                        The Mac did not answer within 2 minutes. Wake-on-LAN needs the Mac on power and on the same LAN as the relay.
                    </Text>
                ) : null}
            </ScrollView>
        </>
    );
}
