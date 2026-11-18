import { SafeJSON } from "@genesiscz/utils/json";
import { actOnSessionHost, describeSessionHosts, type SessionHostTable } from "./registry";
import type { SessionHostAction } from "./types";

/**
 * The JSON `tools ai session-host … --json` prints, built once for both doors that answer it: the CLI and the hub
 * server (`src/hub/server/doors/session-host.ts`). The Genesis window decodes it (GenesisKit `SessionHostPlace.swift`),
 * so both doors must print the same bytes.
 */
export async function sessionHostDescribeJson(
    sessionIds: readonly string[],
    table?: SessionHostTable
): Promise<string> {
    return SafeJSON.stringify({ answers: await describeSessionHosts(sessionIds, table) }, null, 2);
}

/** The action's JSON and whether it succeeded (the CLI exits 1 when it did not). */
export async function sessionHostActJson(
    request: { sessionId: string; action: SessionHostAction },
    table?: SessionHostTable
): Promise<{ json: string; ok: boolean }> {
    const result = await actOnSessionHost(request, table);
    return { json: SafeJSON.stringify(result, null, 2), ok: result.ok };
}
