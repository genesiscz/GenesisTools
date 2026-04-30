export interface ProcessSwap {
    pid: number;
    name: string;
    rssBytes: number;
    swapBytes: number;
    uptimeMs: number;
}

export interface SystemSwap {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
}

export interface ScanOptions {
    limit: number;
    all: boolean;
}

export interface ScanResult {
    system: SystemSwap;
    processes: ProcessSwap[];
    scannedCount: number;
    totalProcesses: number;
    cacheHits: number;
    freshScans: number;
}
