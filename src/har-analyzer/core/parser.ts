import { resolve } from "node:path";
import type { HarEntry, HarFile, HarSession, IndexedEntry, SessionStats } from "@app/har-analyzer/types.ts";

function extractDomainAndPath(url: string): { domain: string; path: string } {
    try {
        const parsed = new URL(url);
        return { domain: parsed.hostname, path: parsed.pathname + parsed.search };
    } catch {
        return { domain: "unknown", path: url };
    }
}

function buildIndexedEntry(entry: HarEntry, index: number): IndexedEntry {
    const { domain, path } = extractDomainAndPath(entry.request.url);
    const status = entry.response.status;

    return {
        index,
        method: entry.request.method,
        url: entry.request.url,
        domain,
        path,
        status,
        statusText: entry.response.statusText,
        mimeType: entry.response.content.mimeType,
        requestSize: Math.max(0, entry.request.bodySize),
        responseSize: Math.max(0, entry.response.content.size),
        timeMs: entry.time,
        startedDateTime: entry.startedDateTime,
        requestBodySize: Math.max(0, entry.request.bodySize),
        responseBodySize: Math.max(0, entry.response.bodySize),
        requestBodyMimeType: entry.request.postData?.mimeType ?? "",
        hasRequestBody: entry.request.bodySize > 0,
        hasResponseBody: entry.response.bodySize > 0,
        isError: status >= 400,
        isRedirect: status >= 300 && status < 400,
        redirectURL: entry.response.redirectURL,
    };
}

function getStatusBucket(status: number): string {
    if (status >= 200 && status < 300) return "2xx";
    if (status >= 300 && status < 400) return "3xx";
    if (status >= 400 && status < 500) return "4xx";
    if (status >= 500 && status < 600) return "5xx";
    return `${Math.floor(status / 100)}xx`;
}

function computeStats(entries: IndexedEntry[]): SessionStats {
    const statusDistribution: Record<string, number> = {};
    const domains: Record<string, number> = {};
    const mimeTypeDistribution: Record<string, number> = {};
    let totalSizeBytes = 0;
    let totalTimeMs = 0;
    let errorCount = 0;

    for (const entry of entries) {
        // Status distribution
        const bucket = getStatusBucket(entry.status);
        statusDistribution[bucket] = (statusDistribution[bucket] ?? 0) + 1;

        // Domain counts
        domains[entry.domain] = (domains[entry.domain] ?? 0) + 1;

        // MIME type distribution
        const mime = entry.mimeType || "unknown";
        mimeTypeDistribution[mime] = (mimeTypeDistribution[mime] ?? 0) + 1;

        // Totals
        totalSizeBytes += entry.responseSize;
        totalTimeMs += entry.timeMs;

        // Error count (4xx + 5xx)
        if (entry.isError) {
            errorCount++;
        }
    }

    const startTime = entries.length > 0 ? entries[0].startedDateTime : "";
    const endTime = entries.length > 0 ? entries[entries.length - 1].startedDateTime : "";

    return {
        entryCount: entries.length,
        domains,
        statusDistribution,
        totalSizeBytes,
        totalTimeMs,
        errorCount,
        mimeTypeDistribution,
        startTime,
        endTime,
    };
}

function buildDomainIndex(entries: IndexedEntry[]): Record<string, number[]> {
    const domainIndex: Record<string, number[]> = {};

    for (const entry of entries) {
        const indices = domainIndex[entry.domain];
        if (indices) {
            indices.push(entry.index);
        } else {
            domainIndex[entry.domain] = [entry.index];
        }
    }

    return domainIndex;
}

export async function loadHarFile(filePath: string): Promise<HarFile> {
    return (await Bun.file(filePath).json()) as HarFile;
}

export async function parseHarFile(filePath: string): Promise<{ session: HarSession; sourceHash: string }> {
    const absolutePath = resolve(filePath);
    const file = Bun.file(absolutePath);

    const [har, rawText] = await Promise.all([file.json() as Promise<HarFile>, file.text()]);

    const sourceHash = Bun.hash(rawText).toString(16);

    const entries = har.log.entries.map((entry, index) => buildIndexedEntry(entry, index));
    const stats = computeStats(entries);
    const domains = buildDomainIndex(entries);

    const now = Date.now();

    const session: HarSession = {
        version: 1,
        sourceFile: absolutePath,
        sourceHash,
        createdAt: now,
        lastAccessedAt: now,
        stats,
        entries,
        domains,
    };

    return { session, sourceHash };
}
