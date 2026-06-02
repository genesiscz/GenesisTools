import type { PulsePoint } from "@dd/contract";
import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KpiCard } from "@/features/pulse/components/KpiCard";
import { NetworkInfo } from "@/features/pulse/components/NetworkInfo";
import { ProcessTable } from "@/features/pulse/components/ProcessTable";
import { HISTORY_RANGES, RangeSelector } from "@/features/pulse/components/RangeSelector";
import { SparklineRow } from "@/features/pulse/components/SparklineRow";
import { WeatherCard } from "@/features/pulse/components/WeatherCard";
import { usePulse, usePulseHistory, useWeather } from "@/features/pulse/hooks";
import { DASH, formatClock, gb, pct, ratioPct } from "@/features/pulse/units";
import { type MetricPoint, MetricChart } from "@/ui/MetricChart";
import { MockBadge } from "@/ui/MockBadge";
import { useThemeColors } from "@/theme/colors";

const formatX = (ms: number) => formatClock(new Date(ms).toISOString());

/** Map the contract's ISO-string points to the chart's epoch-ms points (drop unparseable ts). */
function toMetricPoints(points: PulsePoint[]): MetricPoint[] {
    return points.map((p) => ({ ts: Date.parse(p.ts), value: p.value })).filter((p) => !Number.isNaN(p.ts));
}

export default function PulseScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const [rangeMinutes, setRangeMinutes] = useState<number>(HISTORY_RANGES[0].minutes);

    const snap = usePulse();
    const cpuHistory = usePulseHistory("cpu", rangeMinutes);
    const memHistory = usePulseHistory("mem_free", rangeMinutes);
    const swapHistory = usePulseHistory("swap", rangeMinutes);
    const weather = useWeather();

    const s = snap.data;
    const cpuPoints = useMemo(() => toMetricPoints(cpuHistory.data?.points ?? []), [cpuHistory.data]);
    const memPoints = useMemo(() => toMetricPoints(memHistory.data?.points ?? []), [memHistory.data]);
    const swapPoints = useMemo(() => toMetricPoints(swapHistory.data?.points ?? []), [swapHistory.data]);

    if (snap.isLoading && !s) {
        return (
            <View testID="screen-pulse" className="flex-1 items-center justify-center bg-dd-bg-base">
                <View testID="pulse-loading" className="items-center gap-2">
                    <ActivityIndicator color={c.accent} />
                    <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Loading system pulse…</Text>
                </View>
            </View>
        );
    }

    if (snap.isError && !s) {
        return (
            <View testID="screen-pulse" className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6">
                <Text testID="pulse-error" className="text-base font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                    Pulse unavailable
                </Text>
                <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {snap.error instanceof Error ? snap.error.message : "Could not reach the agent."}
                </Text>
            </View>
        );
    }

    const memValue =
        s?.memFreePct != null ? `${s.memFreePct}% free` : ratioPct(s?.memUsedBytes ?? null, s?.memTotalBytes ?? null);
    const memSub =
        s?.memFreePct != null
            ? `${gb((s.memTotalBytes ?? 0) * (1 - s.memFreePct / 100))} used · ${gb(s?.memTotalBytes ?? null)} total`
            : `${gb(s?.memUsedBytes ?? null)} / ${gb(s?.memTotalBytes ?? null)}`;
    const diskUsed =
        s?.diskTotalBytes != null && s?.diskFreeBytes != null ? s.diskTotalBytes - s.diskFreeBytes : null;

    return (
        <ScrollView
            testID="screen-pulse"
            className="flex-1 bg-dd-bg-base"
            contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16 }}
        >
            <View className="flex-row items-center justify-between">
                <Text
                    accessibilityRole="header"
                    className="text-2xl font-bold tracking-widest"
                    style={{ color: c.accent, fontFamily: "monospace" }}
                >
                    SYSTEM PULSE_
                </Text>
                {/* Live pulse dot — emerald when fetching live data this tick, muted otherwise. */}
                <View
                    testID="pulse-live-dot"
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: snap.isFetching ? c.accent : c.textMuted }}
                />
            </View>

            <MockBadge />

            <View testID="pulse-kpi-grid" className="flex-row flex-wrap gap-3">
                <KpiCard testID="kpi-cpu" label="CPU" value={pct(s?.cpuPct ?? null)} />
                <KpiCard testID="kpi-mem" label="Memory" value={memValue} sub={memSub} />
                <KpiCard
                    testID="kpi-swap"
                    label="Swap"
                    value={ratioPct(s?.swapUsedBytes ?? null, s?.swapTotalBytes ?? null)}
                    sub={gb(s?.swapUsedBytes ?? null)}
                />
                <KpiCard
                    testID="kpi-battery"
                    label="Battery"
                    value={s?.batteryPct == null ? DASH : `${s.batteryPct}%`}
                    sub={s?.batteryState ?? undefined}
                />
                <KpiCard
                    testID="kpi-disk"
                    label="Disk"
                    value={ratioPct(diskUsed, s?.diskTotalBytes ?? null)}
                    sub={`${gb(s?.diskFreeBytes ?? null)} free`}
                />
                <KpiCard testID="kpi-wifi" label="Wi-Fi" value={s?.wifiSsid ?? DASH} sub={s?.publicIp ?? undefined} />
            </View>

            <SparklineRow cpu={cpuPoints} memFree={memPoints} swap={swapPoints} />

            <RangeSelector value={rangeMinutes} onChange={setRangeMinutes} />
            <MetricChart testID="chart-cpu" title="CPU" points={cpuPoints} unit="%" formatX={formatX} />
            <MetricChart testID="chart-mem" title="MEMORY FREE" points={memPoints} unit="%" formatX={formatX} />

            <WeatherCard
                tempC={weather.data?.tempC ?? null}
                description={weather.data?.description ?? ""}
                sunrise={weather.data?.sunrise ?? null}
                sunset={weather.data?.sunset ?? null}
                label={weather.data?.label ?? ""}
                error={weather.data?.error}
            />
            <NetworkInfo wifiSsid={s?.wifiSsid ?? null} publicIp={s?.publicIp ?? null} />
            <ProcessTable processes={s?.topProcesses ?? []} />
        </ScrollView>
    );
}
