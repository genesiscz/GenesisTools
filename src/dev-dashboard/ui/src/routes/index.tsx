import { useQuery } from "@tanstack/react-query";
import { KpiCard } from "@/components/pulse/KpiCard";
import { NetworkInfo } from "@/components/pulse/NetworkInfo";
import { ProcessTable } from "@/components/pulse/ProcessTable";
import { PulseGraph } from "@/components/pulse/PulseGraph";
import { WeatherCard } from "@/components/pulse/WeatherCard";

interface TopProcess {
    pid: number;
    name: string;
    rssBytes: number;
}

interface PulseSnapshot {
    cpuPct: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
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
        queryFn: () => fetch("/api/system/pulse").then((r) => r.json()),
        refetchInterval: 2000,
    });

    const cpuHistory = useQuery<PulseSeries>({
        queryKey: ["pulse", "history", "cpu"],
        queryFn: () =>
            fetch("/api/system/pulse/history?metric=cpu&minutes=30").then((r) => r.json()),
        refetchInterval: 10000,
    });

    const memHistory = useQuery<PulseSeries>({
        queryKey: ["pulse", "history", "mem"],
        queryFn: () =>
            fetch("/api/system/pulse/history?metric=mem&minutes=30").then((r) => r.json()),
        refetchInterval: 10000,
    });

    const weather = useQuery<WeatherSnapshot>({
        queryKey: ["weather"],
        queryFn: () => fetch("/api/weather").then((r) => r.json()),
        refetchInterval: 600000,
    });

    const s = snap.data;

    return (
        <div className="flex flex-col gap-4 font-mono">
            <h1 className="dd-accent-text text-2xl font-bold tracking-widest">SYSTEM PULSE_</h1>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <KpiCard label="CPU" value={pct(s?.cpuPct ?? null)} />
                <KpiCard
                    label="Memory"
                    value={ratioPct(s?.memUsedBytes ?? null, s?.memTotalBytes ?? null)}
                    sub={`${gb(s?.memUsedBytes ?? null)} / ${gb(s?.memTotalBytes ?? null)}`}
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
                    <PulseGraph title="CPU" points={cpuHistory.data?.points ?? []} unit="%" />
                    <PulseGraph title="MEMORY" points={memHistory.data?.points ?? []} unit="%" />
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
