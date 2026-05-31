import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TmuxHubSession } from "@/lib/api";
import { tmuxApi } from "@/lib/api";

interface UseTmuxHubSessionsOptions {
    enabled?: boolean;
    /** Fast list cadence — controls how often the raw tmux session list refreshes. */
    listIntervalMs?: number | false;
    /** Slow cmux-enrichment cadence — cmux layout costs ~150ms per fetch, so it polls
     *  separately and the result is merged into the fast list by session name. */
    cmuxIntervalMs?: number | false;
}

interface UseTmuxHubSessionsResult {
    sessions: TmuxHubSession[];
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    /** True once the slow cmux query has landed at least one result. While false,
     *  `cmuxSurfaces`/`inCmux` are empty/false on every session (default values).
     *  Useful if a consumer wants to gate UI on "we actually know about cmux yet". */
    cmuxReady: boolean;
}

/**
 * Two-query hook for the tmux hub:
 *   1. Fast `/api/tmux/sessions` poll (no cmux) — drives the live session list.
 *   2. Slow `/api/tmux/sessions?include=cmux` poll — drives `cmuxSurfaces`/`inCmux`.
 *
 * The slow result is merged into the fast list by `session.name`. A session that
 * appeared only in the fast list (created since the last cmux poll) renders with
 * `cmuxSurfaces: []` until the next slow tick — i.e. the cmux badge appears with
 * up-to-`cmuxIntervalMs` lag, never blocks the fast list.
 *
 * Why split: the cmux layout fetch is ~150ms (N+1 RPC over workspaces×panes×surfaces),
 * vs ~5ms for the raw list. Polling cmux on every 3s tick was wasting wall-clock on
 * cosmetic data (badge + button styling).
 */
export function useTmuxHubSessions(opts: UseTmuxHubSessionsOptions = {}): UseTmuxHubSessionsResult {
    const enabled = opts.enabled !== false;
    const listInterval = opts.listIntervalMs === false ? false : (opts.listIntervalMs ?? 3000);
    const cmuxInterval = opts.cmuxIntervalMs === false ? false : (opts.cmuxIntervalMs ?? 15000);

    const list = useQuery({
        queryKey: ["tmux", "sessions"],
        queryFn: () => tmuxApi.sessions().then((r) => r.sessions),
        enabled,
        refetchInterval: enabled ? listInterval : false,
    });

    const cmux = useQuery({
        queryKey: ["tmux", "sessions", "cmux"],
        queryFn: () => tmuxApi.sessions({ includeCmux: true }).then((r) => r.sessions),
        enabled,
        refetchInterval: enabled ? cmuxInterval : false,
    });

    const cmuxByName = useMemo(() => {
        const map = new Map<string, Pick<TmuxHubSession, "cmuxSurfaces" | "inCmux">>();

        for (const session of cmux.data ?? []) {
            map.set(session.name, { cmuxSurfaces: session.cmuxSurfaces, inCmux: session.inCmux });
        }

        return map;
    }, [cmux.data]);

    const sessions = useMemo(() => {
        return (list.data ?? []).map((session) => {
            const enrichment = cmuxByName.get(session.name);

            if (!enrichment) {
                return session;
            }

            return { ...session, cmuxSurfaces: enrichment.cmuxSurfaces, inCmux: enrichment.inCmux };
        });
    }, [list.data, cmuxByName]);

    return {
        sessions,
        isLoading: list.isLoading,
        isError: list.isError,
        error: list.error,
        cmuxReady: cmux.data !== undefined,
    };
}
