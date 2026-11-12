import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import adoFetchOutsideApi from "./ado-fetch-outside-api.definition";
import cdpConnOutsideConnect from "./cdp-conn-outside-connect.definition";
import cdpSocketOutsideConnect from "./cdp-socket-outside-connect.definition";
import cmuxSendOutsideSurfaceInput from "./cmux-send-outside-surface-input.definition";
import cmuxTreeOutsideReader from "./cmux-tree-outside-reader.definition";
import type { RosterDefinition } from "./define";
import doctorDirectDelete from "./doctor-direct-delete.definition";
import launchctlOutsideLaunchdAgent from "./launchctl-outside-launchd-agent.definition";
import lockUnlinkOutsidePidfile from "./lock-unlink-outside-pidfile.definition";
import mcpProviderWriteOutsideCycle from "./mcp-provider-write-outside-cycle.definition";
import providerFetchOutsideExchange from "./provider-fetch-outside-exchange.definition";

/** Every roster. A new one is a `<name>.definition.ts` file in this folder plus one line here. */
export const ROSTER_DEFINITIONS: readonly RosterDefinition[] = [
    adoFetchOutsideApi,
    cdpConnOutsideConnect,
    cdpSocketOutsideConnect,
    cmuxSendOutsideSurfaceInput,
    cmuxTreeOutsideReader,
    doctorDirectDelete,
    launchctlOutsideLaunchdAgent,
    lockUnlinkOutsidePidfile,
    mcpProviderWriteOutsideCycle,
    providerFetchOutsideExchange,
];

/** The manifest `generate.ts` writes: per roster, the files that still hold the pattern and how many times. */
export const ROSTERS_FILE = "scripts/ci/rosters/rosters.json";

export type Rosters = Record<string, Record<string, number>>;

export function parseRosters(text: string): Rosters {
    const value: unknown = SafeJSON.parse(text, { strict: true });

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${ROSTERS_FILE}: expected an object of rosters`);
    }

    const rosters: Rosters = {};

    for (const [name, entries] of Object.entries(value)) {
        if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
            throw new Error(`${ROSTERS_FILE}: roster ${name} must be an object of file counts`);
        }

        rosters[name] = {};

        for (const [file, count] of Object.entries(entries)) {
            if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
                throw new Error(`${ROSTERS_FILE}: ${name} → ${file} must be a positive whole count`);
            }

            rosters[name][file] = count;
        }
    }

    return rosters;
}

export function readRosters(root = process.cwd()): Rosters {
    const path = join(root, ROSTERS_FILE);
    return existsSync(path) ? parseRosters(readFileSync(path, "utf8")) : {};
}

/** The per-file counts of one roster, as lint-rules' `allowedCounts` takes them. */
export function rosterCounts(rosters: Rosters, name: string): ReadonlyMap<string, number> {
    return new Map(Object.entries(rosters[name] ?? {}));
}

/** The entries `head` has above `base`: a manifest edited by hand to let a new match in. A new roster is not growth. */
export function rosterGrowth(base: Rosters, head: Rosters): string[] {
    const growth: string[] = [];

    for (const [name, counts] of Object.entries(head)) {
        if (!base[name]) {
            continue;
        }

        for (const [file, count] of Object.entries(counts)) {
            if (count > (base[name][file] ?? 0)) {
                growth.push(`${name}: ${file} ${base[name][file] ?? 0} → ${count}`);
            }
        }
    }

    return growth;
}
