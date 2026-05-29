import { useQuery } from "@tanstack/react-query";
import { SegmentedControl } from "@ui/components/segmented-control";
import { useState } from "react";
import { KpiCard } from "@/components/pulse/KpiCard";
import { NetworkInfo } from "@/components/pulse/NetworkInfo";
import { ProcessTable } from "@/components/pulse/ProcessTable";
import { PulseGraph } from "@/components/pulse/PulseGraph";
import { WeatherCard } from "@/components/pulse/WeatherCard";
import { fetchJson } from "@/lib/api";

interface TopProcess {
    pid: number;
    name: string;
    rssBytes: number;
}

interface PulseSnapshot {
    cpuPct: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
    memFreePct: number | null;
    swapUsedBytes: number | null;
    swapTotalBytes: number | null;
    batteryPct: number | null;
    batteryState: string | null;
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    wifiSsid: string | null;
    publicIp: string | null;
    topProcesses: TopProcess[];
    capturedAt: string;
}

interface PulsePoint {
    ts: string;
    value: number;
}

interface PulseSeries {
    metric: string;
    points: PulsePoint[];
}

interface WeatherSnapshot {
    tempC: number | null;
    weatherCode: number | null;
    description: string;
    sunrise: string | null;
    sunset: string | null;
    label: string;
    fetchedAt: string;
    error?: string;
}

const DASH = "—";

const HISTORY_RANGES = [
    { label: "30m", minutes: 30 },
    { label: "2h", minutes: 120 },
    { label: "6h", minutes: 360 },
    { label: "24h", minutes: 1440 },
] as const;

function pct(value: number | null): string {
    if (value === null) {
        return DASH;
    }

    return `${value.toFixed(1)}%`;
}

function ratioPct(used: number | null, total: number | null): string {
    if (used === null || !total) {
        return DASH;
    }

    return `${((used / total) * 100).toFixed(0)}%`;
}

function gb(bytes: number | null): string {
    if (bytes === null) {
        return DASH;
    }

    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function IndexRoute() {
    const snap = useQuery<PulseSnapshot>({
        queryKey: ["pulse", "snap"],
        queryFn: () => fetchJson<PulseSnapshot>("/api/system/pulse"),
        refetchInterval: 5000,
    });

    const [rangeMinutes, setRangeMinutes] = useState<string>(String(HISTORY_RANGES[0].minutes));
    const rangeMinutesNum = Number(rangeMinutes);

    const cpuHistory = useQuery<PulseSeries>({
        queryKey: ["pulse", "history", "cpu", rangeMinutesNum],
        queryFn: () => fetchJson<PulseSeries>(`/api/system/pulse/history?metric=cpu&minutes=${rangeMinutesNum}`),
        refetchInterval: 10000,
    });

    const memHistory = useQuery<PulseSeries>({
        queryKey: ["pulse", "history", "mem_free", rangeMinutesNum],
        queryFn: () => fetchJson<PulseSeries>(`/api/system/pulse/history?metric=mem_free&minutes=${rangeMinutesNum}`),
        refetchInterval: rangeMinutesNum >= 1440 ? 60000 : 10000,
    });

    const weather = useQuery<WeatherSnapshot>({
        queryKey: ["weather"],
        queryFn: () => fetchJson<WeatherSnapshot>("/api/weather"),
        refetchInterval: 600000,
    });

    const s = snap.data;

    if (snap.isLoading && !s) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] items-center justify-center font-mono text-[var(--dd-text-muted)]">
                Loading system pulse…
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 font-mono">
            <h1 className="dd-accent-text text-2xl font-bold tracking-widest">SYSTEM PULSE_</h1>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <KpiCard label="CPU" value={pct(s?.cpuPct ?? null)} />
                <KpiCard
                    label="Memory"
                    value={
                        s?.memFreePct != null
                            ? `${s.memFreePct}% free`
                            : ratioPct(s?.memUsedBytes ?? null, s?.memTotalBytes ?? null)
                    }
                    sub={
                        s?.memFreePct != null
                            ? `${gb((s.memTotalBytes ?? 0) * (1 - s.memFreePct / 100))} used · ${gb(s?.memTotalBytes ?? null)} total`
                            : `${gb(s?.memUsedBytes ?? null)} / ${gb(s?.memTotalBytes ?? null)}`
                    }
                />
                <KpiCard
                    label="Swap"
                    value={ratioPct(s?.swapUsedBytes ?? null, s?.swapTotalBytes ?? null)}
                    sub={gb(s?.swapUsedBytes ?? null)}
                />
                <KpiCard
                    label="Battery"
                    value={s?.batteryPct == null ? DASH : `${s.batteryPct}%`}
                    sub={s?.batteryState ?? undefined}
                />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
                <div className="flex flex-col gap-4 lg:col-span-2">
                    <div className="flex justify-end">
                        <SegmentedControl
                            tone="dd"
                            aria-label="History time range"
                            className="w-auto"
                            value={rangeMinutes}
                            onValueChange={setRangeMinutes}
                            options={HISTORY_RANGES.map(({ label, minutes }) => ({
                                value: String(minutes),
                                label,
                            }))}
                        />
                    </div>
                    <PulseGraph title="CPU" points={cpuHistory.data?.points ?? []} unit="%" />
                    <PulseGraph title="Memory free" points={memHistory.data?.points ?? []} unit="%" />
                </div>
                <div className="flex flex-col gap-4">
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
                </div>
            </div>
        </div>
    );
}
