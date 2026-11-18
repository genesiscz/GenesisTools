import { SafeJSON } from "@genesiscz/utils/json";
import { connectorConfigOf } from "./connectors/config";
import { DRIFT_NOTE_PREFIX, type PairingState } from "./connectors/types";
import { loadWorkRules } from "./rules/load";
import type { RuleLayerInput } from "./rules/resolve";
import type { WorkContext } from "./service";
import type { PairingRow } from "./wire";

export interface RowPairings {
    pairings?: PairingRow[];
}

interface StoredRow {
    item: string;
    project: string;
    connector: string;
    remoteKey: string;
    state: PairingState;
    note: string | null;
}

type ConnectorDetails = Pick<PairingRow, "displayName" | "enabled">;

function connectorDetails(layers: readonly RuleLayerInput[], connector: string): ConnectorDetails {
    const config = connectorConfigOf(layers, connector).config;
    const enabled = config?.enabled === true;
    const settings = config?.settings;
    if (settings && typeof settings === "object" && "server" in settings && typeof settings.server === "string") {
        return { enabled, displayName: settings.server };
    }

    return { enabled };
}

function pairingRow({ connector, remoteKey, state, note }: StoredRow, details: ConnectorDetails): PairingRow {
    const row: PairingRow = { connector, ...details, remoteKey, state };

    if (note) {
        row.note = note;
    }

    if (state === "drift" && note?.startsWith(DRIFT_NOTE_PREFIX.local)) {
        row.driftDirection = "local";
    } else if (state === "drift" && note?.startsWith(DRIFT_NOTE_PREFIX.remote)) {
        row.driftDirection = "remote";
    }

    return row;
}

/** A tree may repeat a member. Read its pairings once, even when several containers hold it. */
export async function pairingsForRows(ctx: WorkContext, refs: string[]) {
    const byItem = new Map<string, PairingRow[]>();
    const rows = refs.length
        ? ctx.db
              .query<StoredRow, [string]>(
                  `SELECT p.item, i.project, p.connector, p.remote_key AS remoteKey, p.state,
                          json_extract(p.origin, '$.note') AS note
                   FROM pairings p JOIN items i ON i.id = p.item
                   WHERE p.item IN (SELECT value FROM json_each(?)) ORDER BY p.connector, p.item`
              )
              .all(SafeJSON.stringify([...new Set(refs)], { strict: true }))
        : [];

    // An unfiltered triage can contain several projects with different names for the same connector.
    for (const [project, projectRows] of Map.groupBy(rows, (row) => row.project)) {
        const layers =
            project === ctx.project ? (ctx.rules?.layers ?? []) : (await loadWorkRules({ project })).rules.layers;

        for (const [connector, connectorRows] of Map.groupBy(projectRows, (row) => row.connector)) {
            const details = connectorDetails(layers, connector);

            for (const row of connectorRows) {
                const pairings = byItem.get(row.item) ?? [];
                pairings.push(pairingRow(row, details));
                byItem.set(row.item, pairings);
            }
        }
    }

    return <T extends { ref: string }>(row: T): T & RowPairings => {
        const pairings = byItem.get(row.ref);
        return { ...row, ...(pairings ? { pairings } : {}) };
    };
}
