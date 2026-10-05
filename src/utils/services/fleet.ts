import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { type EnsureResult, ensureRegisteredPort } from "@genesiscz/utils/services/ensure";
import { type ServiceRow, verifiedRegistryPorts } from "@genesiscz/utils/services/inventory";
import { type LifecycleResult, stopService } from "@genesiscz/utils/services/lifecycle";
import { listDashboards, listWebServices, type RegistryEntry } from "@genesiscz/utils/ui/dashboards";

/**
 * Registered servers that another system keeps running, or that need their own setup. `up` and `down`
 * leave them alone unless they are named: a bare `down` must never stop the MCP gateway or the proxy.
 * `artifact` serves the folder it is started in and registers it, and its registered launch command names no
 * folder, so a bare `up` would serve and register whatever directory the caller stands in.
 */
export const OUTSIDE_THE_FLEET: ReadonlySet<string> = new Set([
    "ai-proxy",
    "artifact",
    "mcp-gateway",
    "youtube-extension",
    "dev-dashboard-cloud",
]);

export interface FleetSelection {
    entries: RegistryEntry[];
    /** Keys that are not in the registry, or have no launch command. */
    unknown: string[];
}

/**
 * The registered servers to act on, API servers before the dashboards that call them. Named keys select
 * exactly those; no keys selects every launchable entry outside `OUTSIDE_THE_FLEET`. `except` always wins.
 */
export function selectFleet({
    keys = [],
    except = [],
    registry = [...listWebServices(), ...listDashboards()],
}: {
    keys?: string[];
    except?: string[];
    registry?: readonly RegistryEntry[];
} = {}): FleetSelection {
    const launchable = registry.filter((entry) => entry.launch !== null);
    const unknown = keys.filter((key) => !launchable.some((entry) => entry.key === key));
    const chosen =
        keys.length > 0
            ? launchable.filter((entry) => keys.includes(entry.key))
            : launchable.filter((entry) => !OUTSIDE_THE_FLEET.has(entry.key));

    return { entries: chosen.filter((entry) => !except.includes(entry.key)), unknown };
}

export interface FleetOutcome {
    key: string;
    name: string;
    port: number;
    outcome: "started" | "running" | "failed" | "stopped" | "not running" | "launchd";
    message: string;
}

export interface PortMove {
    variable: string;
    port: number;
}

/**
 * Where an entry's override variable (`YOUTUBE_UI_PORT`) moves it, or null when the variable is unset, not a
 * port, or names the registry port. `up` and `down` find a server by its registry port, so they cannot manage
 * one that listens somewhere else: `up` would time out on the registry port and leave the server running.
 */
export function portMove({
    entry,
    vars = env.getProcessEnv(),
}: {
    entry: RegistryEntry;
    vars?: Record<string, string | undefined>;
}): PortMove | null {
    const variable = entry.portOverride?.env;

    if (!variable) {
        return null;
    }

    const port = Number(vars[variable]?.trim());

    return Number.isInteger(port) && port > 0 && port !== entry.port ? { variable, port } : null;
}

/**
 * Starts what is not listening yet: API servers first and together, then the dashboards together. A port that
 * already accepts connections counts as running only when its listener is the registered server; any other
 * process there is a collision, and a failed outcome.
 */
export async function startFleet({
    entries,
    ensure = ensureRegisteredPort,
    verifiedPorts = verifiedRegistryPorts,
}: {
    entries: RegistryEntry[];
    ensure?: (port: number) => Promise<EnsureResult>;
    /** The registered ports whose listener is the registered server. Read once, and only when a port already listens. */
    verifiedPorts?: () => ReadonlySet<number>;
}): Promise<FleetOutcome[]> {
    const outcomes: FleetOutcome[] = [];
    let verified: ReadonlySet<number> | undefined;
    const api = entries.filter((entry) => !("strictPort" in entry));
    const ui = entries.filter((entry) => "strictPort" in entry);

    for (const group of [api, ui]) {
        const results = await Promise.all(
            group.map(async (entry): Promise<FleetOutcome> => {
                const base = { key: entry.key, name: entry.name, port: entry.port };
                const move = portMove({ entry });

                if (move) {
                    return {
                        ...base,
                        outcome: "failed",
                        message: `${move.variable} moves it to port ${move.port}; up manages port ${entry.port} only. Unset it or start the server yourself`,
                    };
                }

                try {
                    const result = await ensure(entry.port);

                    if (!result.ok) {
                        return { ...base, outcome: "failed", message: result.message };
                    }

                    if (result.started) {
                        return { ...base, outcome: "started", message: `listening on ${entry.port}` };
                    }

                    verified ??= verifiedPorts();

                    if (!verified.has(entry.port)) {
                        return {
                            ...base,
                            outcome: "failed",
                            message: `port ${entry.port} is held by a process that is not ${entry.name}. Find it with \`lsof -nP -iTCP:${entry.port} -sTCP:LISTEN\``,
                        };
                    }

                    return { ...base, outcome: "running", message: `already listening on ${entry.port}` };
                } catch (error) {
                    logger.warn({ error, key: entry.key, port: entry.port }, "services: fleet start threw");

                    return {
                        ...base,
                        outcome: "failed",
                        message: error instanceof Error ? error.message : String(error),
                    };
                }
            })
        );
        outcomes.push(...results);
    }

    return outcomes;
}

/** Stops the detached servers among `entries`, dashboards first. A launchd job is named, never stopped. */
export async function stopFleet({
    entries,
    rows,
    stop = stopService,
}: {
    entries: RegistryEntry[];
    rows: ServiceRow[];
    stop?: (row: ServiceRow) => Promise<LifecycleResult>;
}): Promise<FleetOutcome[]> {
    const outcomes: FleetOutcome[] = [];

    for (const entry of [...entries].reverse()) {
        const base = { key: entry.key, name: entry.name, port: entry.port };
        const row = rows.find((candidate) => candidate.port === entry.port);

        if (!row) {
            outcomes.push({ ...base, outcome: "not running", message: "nothing listens on its port" });
            continue;
        }

        if (row.managed === "launchd") {
            outcomes.push({
                ...base,
                outcome: "launchd",
                message: `kept by launchd (${row.label}); use \`services restart ${row.id}\` or its own down command`,
            });
            continue;
        }

        const result = await stop(row);
        outcomes.push({ ...base, outcome: result.ok ? "stopped" : "failed", message: result.message });
    }

    return outcomes;
}
