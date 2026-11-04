import type { GateDecisionDto, GateRaiseReceiptDto, GateWaitDto } from "@dd/contract";
import { Stack } from "expo-router";
import { memo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useGateLedger, useRaiseGate } from "@/features/gates/hooks";
import { GATE_LABELS, requestBytes, waitLine } from "@/features/gates/queries";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

function megabytes(bytes: number): string {
    return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

const WaitCard = memo(function WaitCard({ wait, now }: { wait: GateWaitDto; now: number }) {
    const c = useThemeColors();
    const [receipt, setReceipt] = useState<GateRaiseReceiptDto | null>(null);
    const raise = useRaiseGate(setReceipt);
    const bytes = requestBytes(wait);

    return (
        <View
            testID={`gate-${wait.id}`}
            className="gap-2 rounded-2xl p-4"
            style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: wait.window ? c.warning : c.border }}
        >
            <View className="flex-row items-center gap-2">
                <StatusPill label={GATE_LABELS[wait.gate]} tone={wait.window ? "danger" : "muted"} normalCase />
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>{waitLine(wait, now)}</Text>
            </View>
            <Text style={{ color: c.textPrimary, fontSize: 15, fontWeight: "600" }}>{wait.title}</Text>
            {wait.who ? (
                <Text numberOfLines={1} style={{ color: c.textSecondary, fontSize: 12 }}>{`Asked by ${wait.who}`}</Text>
            ) : null}
            {wait.request ? (
                <View className="gap-1">
                    {wait.request.paths.slice(0, 4).map((path) => (
                        <Text
                            key={path.path}
                            numberOfLines={1}
                            style={{ color: c.textSecondary, fontFamily: "monospace", fontSize: 11 }}
                        >
                            {path.path}
                        </Text>
                    ))}
                    {wait.request.paths.length > 4 ? (
                        <Text style={{ color: c.textMuted, fontSize: 11 }}>{`+${wait.request.paths.length - 4} more`}</Text>
                    ) : null}
                    <Text style={{ color: c.textMuted, fontSize: 12 }}>
                        {[wait.request.reason, bytes === null ? null : megabytes(bytes)].filter(Boolean).join(" · ")}
                    </Text>
                </View>
            ) : null}
            <Pressable
                testID={`gate-raise-${wait.id}`}
                accessibilityRole="button"
                accessibilityLabel={wait.window ? "Bring the window to the front on the Mac" : "Open the window on the Mac"}
                disabled={raise.isPending}
                onPress={() => raise.mutate({ id: wait.id, idempotencyKey: idempotencyKey() })}
                className="mt-1 items-center rounded-xl py-2.5"
                style={{ backgroundColor: c.accentMuted, borderWidth: 1, borderColor: c.accentGlow, opacity: raise.isPending ? 0.6 : 1 }}
            >
                <Text style={{ color: c.accent, fontWeight: "600" }}>
                    {wait.window ? "Bring to front on the Mac" : "Open on the Mac"}
                </Text>
            </Pressable>
            {receipt ? (
                <Text testID={`gate-receipt-${wait.id}`} style={{ color: c.textMuted, fontSize: 12 }}>
                    {receipt.detail}
                </Text>
            ) : null}
            {raise.isError ? (
                <Text style={{ color: c.danger, fontSize: 12 }}>{String(raise.error)}</Text>
            ) : null}
        </View>
    );
});

function DecisionRow({ decision }: { decision: GateDecisionDto }) {
    const c = useThemeColors();

    return (
        <View className="flex-row items-center gap-2 py-1.5">
            <Text style={{ color: decision.event === "denied" ? c.danger : c.accent, fontFamily: "monospace", fontSize: 11 }}>
                {decision.event}
            </Text>
            <Text numberOfLines={1} className="flex-1" style={{ color: c.textSecondary, fontSize: 12 }}>
                {decision.title}
            </Text>
            <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                {new Date(decision.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
        </View>
    );
}

/**
 * The Touch ID waiting card (F22): vault and AI account windows that wait on the Mac's sensor, and rm requests with
 * their paths and sizes. Read only: the button brings a window to the Mac's front or opens one for an rm request, so
 * it waits there when you sit down. The decision itself stays on the Mac.
 */
export default function TouchIdScreen() {
    const c = useThemeColors();
    const ledger = useGateLedger();
    const now = Date.now();
    const pending = ledger.data?.pending ?? [];
    const recent = ledger.data?.recent ?? [];

    return (
        <>
            <Stack.Screen options={{ title: "Touch ID" }} />
            <ScrollView
                testID="screen-touch-id"
                accessibilityLabel="screen-touch-id"
                className="flex-1 bg-dd-bg-base"
                contentInsetAdjustmentBehavior="automatic"
                contentContainerClassName="gap-3 p-4"
                refreshControl={
                    <RefreshControl refreshing={ledger.isRefetching} onRefresh={() => void ledger.refetch()} tintColor={c.accent} />
                }
            >
                <View className="flex-row flex-wrap items-center gap-2">
                    <StatusPill label={`${pending.length} waiting`} tone={pending.length > 0 ? "danger" : "muted"} normalCase />
                    <MockBadge />
                </View>
                {ledger.isPending ? (
                    <View className="items-center gap-2 py-10">
                        <ActivityIndicator color={c.accent} />
                    </View>
                ) : ledger.isError ? (
                    <Text testID="gates-error" style={{ color: c.danger }}>{String(ledger.error)}</Text>
                ) : pending.length === 0 ? (
                    <Empty title="Nothing waits on Touch ID" hint="Vault, AI account and delete requests show here." />
                ) : (
                    pending.map((wait) => <WaitCard key={wait.id} wait={wait} now={now} />)
                )}
                {recent.length > 0 ? (
                    <View className="gap-1 pt-2">
                        <SectionHeader title="Recent decisions" />
                        {recent.map((decision) => (
                            <DecisionRow key={`${decision.gate}-${decision.at}`} decision={decision} />
                        ))}
                    </View>
                ) : null}
            </ScrollView>
        </>
    );
}
