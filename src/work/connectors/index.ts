/**
 * The connector table. A new connector is one folder beside these and one row here; the library reaches the table
 * through the `ConnectorPort`, and each project turns a connector on in its `connectors.<id>` config section.
 */

import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { connectorConfigOf } from "@genesiscz/utils/work/connectors/config";
import type { SyncDeps } from "@genesiscz/utils/work/connectors/sync";
import type { Connector } from "@genesiscz/utils/work/connectors/types";
import type { ConnectorPort } from "@genesiscz/utils/work/ports";
import { type LoadProjectRules, loadRulesForItems, readWorkConfig } from "@genesiscz/utils/work/rules/load";
import type { RuleLayerInput } from "@genesiscz/utils/work/rules/resolve";
import { itemsChangedAfter } from "@genesiscz/utils/work/store/rows";
import { remindersConnector } from "./reminders";
import { trackerConnector } from "./tracker";

export const CONNECTORS: Readonly<Record<string, Connector<unknown>>> = {
    reminders: remindersConnector,
    tracker: trackerConnector,
};

export function connectorPort(db: Database, loadRules: LoadProjectRules): ConnectorPort {
    return {
        syncDeps(): SyncDeps {
            const machine = readWorkConfig().value.machine?.prefix ?? "";
            return {
                db,
                connectors: CONNECTORS,
                loadRules,
                machinePrefix: machine,
                now: () => new Date().toISOString(),
                owner: `${hostname()}:${process.pid}`,
            };
        },
    };
}

/** True when a project's layers turn on at least one connector of the table: then a write starts a detached sync. */
export function connectorsEnabled(layers: readonly RuleLayerInput[]): boolean {
    return Object.keys(CONNECTORS).some((id) => connectorConfigOf(layers, id).config?.enabled === true);
}

/** A write to another project's item can start a sync even when the caller has every connector turned off. */
export async function syncNeededAfter({
    db,
    seq,
    loadRules,
}: {
    db: Database;
    seq: number;
    loadRules: LoadProjectRules;
}): Promise<boolean> {
    const changed = itemsChangedAfter(db, seq).map((item) => ({ item }));
    const projects = await loadRulesForItems(changed, loadRules);
    return Array.from(projects.values()).some(({ loaded }) => connectorsEnabled(loaded.rules.layers));
}
