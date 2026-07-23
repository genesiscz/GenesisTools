import type {
    CmuxLayoutRes,
    CmuxSnapshotRes,
    DashboardClient,
    TmuxSessionsRes,
    TtydListRes,
} from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Terminals feature data layer (D32 + the per-feature layout copied from `src/features/pulse/`).
 * Owns the co-located query keys (`terminalsKeys`) AND one TanStack-v5 `queryOptions` FACTORY per
 * read endpoint, each closing over the injected `DashboardClient`. The thin `use*` hooks in
 * `./hooks` pass `useDashboardClient()` here. Mutations (spawn/kill/rename/create) are thin client
 * callers exposed as `*Mutation` factories the hooks wrap in `useMutation` — components NEVER call
 * the raw client or raw `useMutation`/`useQuery` (hard D32 rule).
 *
 * Sessions come from THREE domains the contract already exposes (mock-client covers all of them):
 *   - `tmux.sessions()`  → tmux hub sessions (+ their ttyd/cmux bindings)
 *   - `ttyd.list()`      → live ttyd PTYs (the actual things a WebView driver attaches to)
 *   - `cmux.snapshot()`  → cmux workspaces/panes (surfaced for parity with the web dashboard)
 *
 * Polling is modest: the session inventory changes on user action (spawn/kill), not continuously,
 * so a ~6 s refetch keeps the list fresh without hammering. The terminal STREAM itself is the ttyd
 * WS (plan 02 transport / Driver B) — not a polled query.
 */

export const terminalsKeys = {
    tmux: ["tmux", "sessions"] as const,
    ttyd: ["ttyd", "list"] as const,
    cmux: {
        snapshot: ["cmux", "snapshot"] as const,
        layout: ["cmux", "layout"] as const,
    },
} as const;

export const SESSIONS_INTERVAL_MS = 6_000;
export const CMUX_INTERVAL_MS = 8_000;

export function tmuxSessionsQuery(client: DashboardClient) {
    return queryOptions<TmuxSessionsRes>({
        queryKey: terminalsKeys.tmux,
        queryFn: () => client.tmux.sessions(),
        refetchInterval: SESSIONS_INTERVAL_MS,
    });
}

export function ttydListQuery(client: DashboardClient) {
    return queryOptions<TtydListRes>({
        queryKey: terminalsKeys.ttyd,
        queryFn: () => client.ttyd.list(),
        refetchInterval: SESSIONS_INTERVAL_MS,
    });
}

export function cmuxSnapshotQuery(client: DashboardClient) {
    return queryOptions<CmuxSnapshotRes>({
        queryKey: terminalsKeys.cmux.snapshot,
        queryFn: () => client.cmux.snapshot(),
        refetchInterval: CMUX_INTERVAL_MS,
    });
}

export function cmuxLayoutQuery(client: DashboardClient) {
    return queryOptions<CmuxLayoutRes>({
        queryKey: terminalsKeys.cmux.layout,
        queryFn: () => client.cmux.layout(),
        refetchInterval: CMUX_INTERVAL_MS,
    });
}

/* ── Mutations (thin client callers; the hooks wrap these in useMutation) ────────────────────── */

export interface SpawnTtydInput {
    command?: string;
    cwd?: string;
    tmuxSessionName?: string;
}

export interface RenameTtydInput {
    id: string;
    name: string;
}

export interface KillTtydInput {
    id: string;
    killTmux?: boolean;
}

export interface CreateTmuxInput {
    name?: string;
    cwd?: string;
    command?: string;
}

export interface RenameTmuxInput {
    /** Current tmux session name. */
    from: string;
    /** New tmux session name. */
    to: string;
}

export interface CmuxAttachInput {
    workspaceId: string;
    paneId: string;
}

export function spawnTtyd(client: DashboardClient, input: SpawnTtydInput) {
    return client.ttyd.spawn(input);
}

export function killTtyd(client: DashboardClient, input: KillTtydInput) {
    return client.ttyd.kill(input.id, input.killTmux ?? false);
}

export function renameTtyd(client: DashboardClient, input: RenameTtydInput) {
    return client.ttyd.rename(input.id, input.name);
}

export function createTmux(client: DashboardClient, input: CreateTmuxInput) {
    return client.tmux.create(input);
}

export function renameTmux(client: DashboardClient, input: RenameTmuxInput) {
    return client.tmux.rename(input);
}

export function cmuxAttach(client: DashboardClient, input: CmuxAttachInput) {
    return client.cmux.attach(input);
}
