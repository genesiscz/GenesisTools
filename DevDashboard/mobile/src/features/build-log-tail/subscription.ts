import type { ClassifiedLogEntry, DashboardClient } from "@dd/contract";

/**
 * Renderer-free controller around `client.buildLog.subscribe` (the single SSE seam — the contract
 * wires `eventSourceFactory`). Mirrors qa/subscription.ts: dedupes lines across the session, reports
 * coarse liveness, exposes one idempotent `close()`. Log lines have no id, so we dedupe by a composite
 * `${ts}|${data}` key (a daemon writes one entry per line; ts+data is unique enough — and dropping a
 * genuine duplicate line is harmless for a viewer).
 */

export type BuildLogStatus = "connecting" | "open" | "live";

export interface BuildLogCallbacks {
    onLine: (entry: ClassifiedLogEntry) => void;
    onStatus?: (status: BuildLogStatus) => void;
}

export interface BuildLogSubscriptionHandle {
    close(): void;
}

function keyOf(entry: ClassifiedLogEntry): string {
    if (entry.type === "exit") {
        return `exit|${entry.ts}|${entry.code}`;
    }

    if (entry.type === "meta") {
        return `meta|${entry.runId}`;
    }

    return `${entry.ts}|${entry.data}`;
}

export function openBuildLogSubscription(
    client: DashboardClient,
    logFile: string,
    callbacks: BuildLogCallbacks,
): BuildLogSubscriptionHandle {
    const seen = new Set<string>();
    let closed = false;

    callbacks.onStatus?.("connecting");

    const sub = client.buildLog.subscribe(logFile, (entry) => {
        if (closed) {
            return;
        }

        const key = keyOf(entry);
        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        callbacks.onStatus?.("live");
        callbacks.onLine(entry);
    });

    if (!closed) {
        callbacks.onStatus?.("open");
    }

    return {
        close() {
            if (closed) {
                return;
            }

            closed = true;
            sub.close();
        },
    };
}
