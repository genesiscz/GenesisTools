export interface TopProcess {
    pid: number;
    name: string;
    rssBytes: number;
}

export interface PulseSnapshot {
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

export interface PulsePoint {
    ts: string;
    value: number;
}

export interface PulseSeries {
    metric: string;
    points: PulsePoint[];
}
