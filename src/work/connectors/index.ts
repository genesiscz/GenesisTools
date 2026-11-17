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
import { readWorkConfig } from "@genesiscz/utils/work/rules/load";
import type { RuleLayerInput } from "@genesiscz/utils/work/rules/resolve";
import { remindersConnector } from "./reminders";
import { trackerConnector } from "./tracker";

export const CONNECTORS: Readonly<Record<string, Connector<unknown>>> = {
    reminders: remindersConnector,
    tracker: trackerConnector,
};

export function connectorPort(db: Database): ConnectorPort {
    return {
        syncDeps(_project, layers): SyncDeps {
            const machine = readWorkConfig().value.machine?.prefix ?? "";
            return {
                db,
                connectors: CONNECTORS,
                config: (_itemProject, id) => connectorConfigOf(layers, id).config,
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
