import type { ContainersResult, DashboardClient } from "@dd/contract";
import { paths } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Containers feature data layer (D32 + per-feature layout). Co-locates `containersKeys` and the
 * `queryOptions` factory over the injected `DashboardClient`. Mirrors src/features/pulse/queries.ts.
 *
 * ESCAPE-HATCH NOTE: the contract has no typed `client.containers.*` namespace yet — the deferred
 * features use generic `client.get<T>(path)`. We supply `T` (`ContainersResult`) and build the path
 * via `paths.containers()`. The mock returns a real `ContainersResult` for `/api/containers`
 * (`{ dockerAvailable: false, containers: [] }`).
 *
 * LOGS NOTE: there is NO container-logs endpoint in the contract (only `/api/containers`) — so this
 * feature does list + dockerAvailable + running/stopped only; per-container logs are unbacked and
 * deliberately NOT faked. (Run logs belong to the daemon feature via `/api/daemon/runs/log`.) See
 * 20-impl-09-rest-notes.md.
 *
 * Polling: 10 s (container state flips on up/down).
 */

export const containersKeys = {
    list: ["containers", "list"] as const,
} as const;

export const CONTAINERS_INTERVAL_MS = 10_000;

const EMPTY_RESULT: ContainersResult = { dockerAvailable: false, containers: [] };

/** Coerce an escape-hatch payload to a well-formed ContainersResult (defensive vs. an unknown route). */
function asContainersResult(value: unknown): ContainersResult {
    if (value && typeof value === "object" && Array.isArray((value as { containers?: unknown }).containers)) {
        return value as ContainersResult;
    }

    return EMPTY_RESULT;
}

export function containersQuery(client: DashboardClient) {
    return queryOptions<ContainersResult>({
        queryKey: containersKeys.list,
        queryFn: async () => asContainersResult(await client.get<ContainersResult>(paths.containers())),
        refetchInterval: CONTAINERS_INTERVAL_MS,
    });
}
