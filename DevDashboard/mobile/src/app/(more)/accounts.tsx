import type { ForecastAccountDto, ForecastWindowDto } from "@dd/contract";
import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import { useQuery } from "@tanstack/react-query";
import { Stack, useIsFocused } from "expo-router";
import { memo, useMemo } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { forecastQuery, paceLine, resetLine, ringTone } from "@/features/accounts/queries";
import { useThemeColors } from "@/theme/colors";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { StatusPill } from "@/ui/StatusPill";

const RING = 56;
const STROKE = 6;

function Ring({ percent, color, track }: { percent: number; color: string; track: string }) {
    const { full, used } = useMemo(() => {
        const rect = Skia.XYWHRect(STROKE / 2, STROKE / 2, RING - STROKE, RING - STROKE);
        const background = Skia.Path.Make();
        background.addArc(rect, 0, 360);
        const arc = Skia.Path.Make();
        arc.addArc(rect, -90, (Math.min(100, Math.max(0, percent)) / 100) * 360);
        return { full: background, used: arc };
    }, [percent]);

    return (
        <View style={{ width: RING, height: RING }}>
            <Canvas style={{ width: RING, height: RING }}>
                <Path path={full} style="stroke" strokeWidth={STROKE} color={track} />
                <Path path={used} style="stroke" strokeWidth={STROKE} strokeCap="round" color={color} />
            </Canvas>
            <View className="absolute inset-0 items-center justify-center">
                <Text style={{ color, fontSize: 12, fontWeight: "700" }}>{`${Math.round(percent)}%`}</Text>
            </View>
        </View>
    );
}

function WindowRow({ window, now }: { window: ForecastWindowDto; now: number }) {
    const c = useThemeColors();
    const tones = { danger: c.danger, warning: c.warning, accent: c.accent } as const;
    const reset = resetLine(window, now);
    const pace = paceLine(window);

    return (
        <View className="flex-row items-center gap-3" style={{ opacity: window.stale ? 0.55 : 1 }}>
            <Ring percent={window.utilization} color={tones[ringTone(window)]} track={c.border} />
            <View className="flex-1 gap-0.5">
                <Text style={{ color: c.textPrimary, fontWeight: "600" }}>{window.label}</Text>
                {reset ? <Text style={{ color: c.textSecondary, fontSize: 12 }}>{reset}</Text> : null}
                {pace ? <Text style={{ color: c.danger, fontSize: 12 }}>{pace}</Text> : null}
                {window.stale ? <Text style={{ color: c.textMuted, fontSize: 11 }}>old reading</Text> : null}
            </View>
        </View>
    );
}

const AccountCard = memo(function AccountCard({ account, now }: { account: ForecastAccountDto; now: number }) {
    const c = useThemeColors();

    return (
        <View
            testID={`account-${account.provider}-${account.account}`}
            className="gap-3 rounded-2xl p-4"
            style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: account.warning ? c.danger : c.border }}
        >
            <View className="flex-row items-center gap-2">
                <StatusPill label={account.provider} tone="muted" normalCase />
                <Text numberOfLines={1} className="flex-1" style={{ color: c.textPrimary, fontSize: 15, fontWeight: "600" }}>
                    {account.account}
                </Text>
            </View>
            {account.warning ? <Text style={{ color: c.danger, fontSize: 12 }}>{account.warning}</Text> : null}
            {account.windows.length === 0 ? (
                <Text style={{ color: c.textMuted, fontSize: 12 }}>No limit reading stored yet.</Text>
            ) : (
                account.windows.map((window) => <WindowRow key={window.bucket} window={window} now={now} />)
            )}
        </View>
    );
});

/**
 * Accounts (F16): every Claude, Codex and Grok account with a ring per limit window, the reset countdown and the
 * pace line ("runs out at 15:40 at this pace"), from the Mac's forecast over stored readings. Nothing here fetches an
 * account, so no refresh token is spent. The threshold push comes from the Mac's usage alert engine.
 */
export default function AccountsScreen() {
    const c = useThemeColors();
    const focused = useIsFocused();
    const options = forecastQuery(useDashboardClient());
    const forecast = useQuery({ ...options, refetchInterval: focused ? options.refetchInterval : false });
    const accounts = forecast.data?.accounts ?? [];
    const now = Date.now();

    return (
        <>
            <Stack.Screen options={{ title: "Accounts" }} />
            <ScrollView
                testID="screen-accounts"
                accessibilityLabel="screen-accounts"
                className="flex-1 bg-dd-bg-base"
                contentInsetAdjustmentBehavior="automatic"
                contentContainerClassName="gap-3 p-4"
                refreshControl={
                    <RefreshControl refreshing={forecast.isRefetching} onRefresh={() => void forecast.refetch()} tintColor={c.accent} />
                }
            >
                <MockBadge />
                {forecast.isPending ? (
                    <View className="items-center py-10">
                        <ActivityIndicator color={c.accent} />
                    </View>
                ) : forecast.isError ? (
                    <Text testID="accounts-error" style={{ color: c.danger }}>
                        {String(forecast.error)}
                    </Text>
                ) : accounts.length === 0 ? (
                    <Empty title="No account readings" hint="The Mac stores a reading when it polls an account's usage." />
                ) : (
                    accounts.map((account) => (
                        <AccountCard key={`${account.provider}:${account.account}`} account={account} now={now} />
                    ))
                )}
            </ScrollView>
        </>
    );
}
