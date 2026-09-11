import type { ClassifiedLogEntry } from "@dd/contract";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { buildLogBacklogQuery, buildLogRunsQuery } from "@/features/build-log-tail/queries";
import {
    type BuildLogStatus,
    type BuildLogSubscriptionHandle,
    openBuildLogSubscription,
} from "@/features/build-log-tail/subscription";

/** Recent runs for the picker (D32 — components import THIS, never raw useQuery). */
export function useBuildLogRuns() {
    return useQuery(buildLogRunsQuery(useDashboardClient()));
}

/** Pre-tail backlog for the selected run (static log fetch; null logFile = disabled). */
export function useBuildLogBacklog(logFile: string | null) {
    return useQuery(buildLogBacklogQuery(useDashboardClient(), logFile));
}

export interface UseBuildLogStreamResult {
    /** Lines received live over SSE this session, in arrival order (deduped). */
    live: ClassifiedLogEntry[];
    status: BuildLogStatus;
}

/**
 * SSE lifecycle for the selected run's tail. Opens on mount / logFile change, re-opens on AppState
 * `active`, tears down on unmount / background (mirrors useQaStream). `live` is cleared whenever the
 * selected logFile changes so switching runs doesn't bleed lines across.
 */
export function useBuildLogStream(
    logFile: string | null,
    options: { onResume?: () => void } = {},
): UseBuildLogStreamResult {
    const client = useDashboardClient();
    const [live, setLive] = useState<ClassifiedLogEntry[]>([]);
    const [status, setStatus] = useState<BuildLogStatus>("connecting");
    const handleRef = useRef<BuildLogSubscriptionHandle | null>(null);
    const onResumeRef = useRef(options.onResume);
    onResumeRef.current = options.onResume;

    const push = useCallback((entry: ClassifiedLogEntry) => {
        setLive((prev) => [...prev, entry]);
    }, []);

    useEffect(() => {
        setLive([]);
        if (!logFile) {
            setStatus("connecting");
            return;
        }

        function open(): void {
            handleRef.current?.close();
            setStatus("connecting");
            handleRef.current = openBuildLogSubscription(client, logFile as string, {
                onLine: push,
                onStatus: setStatus,
            });
        }

        function close(): void {
            handleRef.current?.close();
            handleRef.current = null;
        }

        open();

        const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
            if (next === "active") {
                open();
                onResumeRef.current?.();
            } else {
                close();
            }
        });

        return () => {
            sub.remove();
            close();
        };
    }, [client, logFile, push]);

    return { live, status };
}
