/**
 * Ping me when done (F15): the Mac watches a live agent session and pushes once when its turn ends, because the
 * phone's own streams die in the background. `src/hub/lib/ping` owns it. Types only (`contract-purity.test.ts`).
 */

export interface PingWatchDto {
    /** The agents board key (`provider:sessionId`). */
    key: string;
    label: string | null;
    since: string;
}

/** `GET /api/gateway/pings`, and the answer of a watch or an unwatch. */
export interface PingWatchesDto {
    watches: PingWatchDto[];
}

/** `POST /api/ping/watch`. */
export interface PingWatchInput {
    key: string;
    label?: string;
}
