import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * `~/.genesis-tools/genesis-tools/state.json`: what is true on this machine, per area, each value with its source and
 * time. The build writes build facts, the app reports parts, grants and the helper, a probe writes what it measured.
 * Config (what the person chose) lives in `config.ts`.
 */

export type StateSource = "build" | "app" | "probe";

export interface StateValue<T = unknown> {
    value: T;
    /** ISO time the value was read. */
    at: string;
    source: StateSource;
    /** The build id the value was read under; a value from another build is not used. */
    build?: string;
    /** Set when a way failed because the value was wrong; the next check probes again. */
    stale?: boolean;
}

export interface GenesisToolsStateFile {
    version: 1;
    areas: Record<string, Record<string, StateValue>>;
}

export interface StateStore {
    read(): GenesisToolsStateFile;
    get<T = unknown>(area: string, key: string): StateValue<T> | undefined;
    report(area: string, key: string, value: StateValue): Promise<void>;
    markStale(area: string, key: string): Promise<void>;
}

const SOURCES: readonly string[] = ["build", "app", "probe"];

export function genesisToolsStatePath(): string {
    return toolDataDir("genesis-tools", "state.json");
}

function emptyState(): GenesisToolsStateFile {
    return { version: 1, areas: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStateValue(value: unknown): value is StateValue {
    return (
        isRecord(value) &&
        "value" in value &&
        typeof value.at === "string" &&
        typeof value.source === "string" &&
        SOURCES.includes(value.source) &&
        (value.build === undefined || typeof value.build === "string") &&
        (value.stale === undefined || typeof value.stale === "boolean")
    );
}

/**
 * Reads a state file's text into the shape. Anything that does not parse (a half-written file, another version, a
 * value of the wrong shape) is dropped, never thrown: state is a cache of facts, and a missing fact is probed again.
 */
export function parseStateText(text: string): GenesisToolsStateFile {
    let raw: unknown;

    try {
        raw = SafeJSON.parse(text, { strict: true });
    } catch (error) {
        logger.debug({ error }, "genesis-tools state: unreadable file, starting empty");
        return emptyState();
    }

    if (!isRecord(raw) || (raw.version !== undefined && raw.version !== 1) || !isRecord(raw.areas)) {
        return emptyState();
    }

    const areas: GenesisToolsStateFile["areas"] = {};

    for (const [area, values] of Object.entries(raw.areas)) {
        if (!isRecord(values)) {
            continue;
        }

        const kept: Record<string, StateValue> = {};

        for (const [key, value] of Object.entries(values)) {
            if (isStateValue(value)) {
                kept[key] = value;
            }
        }

        areas[area] = kept;
    }

    return { version: 1, areas };
}

function withValue(
    file: GenesisToolsStateFile,
    area: string,
    key: string,
    value: StateValue | null
): GenesisToolsStateFile {
    const values = { ...(file.areas[area] ?? {}) };

    if (value === null) {
        delete values[key];
    } else {
        values[key] = value;
    }

    return { version: 1, areas: { ...file.areas, [area]: values } };
}

export interface StateStoreOptions {
    file?: string;
    onChange?: (change: { area: string; key: string; value: StateValue | null }) => void;
}

/** The one writer of state.json: every change is a locked read, merge and write. */
export function createStateStore(options: StateStoreOptions = {}): StateStore {
    const file = options.file ?? genesisToolsStatePath();

    function read(): GenesisToolsStateFile {
        if (!existsSync(file)) {
            return emptyState();
        }

        return parseStateText(readFileSync(file, "utf8"));
    }

    async function change(area: string, key: string, next: (current?: StateValue) => StateValue | null): Promise<void> {
        mkdirSync(dirname(file), { recursive: true });
        const written = await withFileLock(`${file}.lock`, async () => {
            const current = read();
            const value = next(current.areas[area]?.[key]);
            writeFileSync(file, `${SafeJSON.stringify(withValue(current, area, key, value), null, 2)}\n`);
            return value;
        });
        options.onChange?.({ area, key, value: written });
    }

    return {
        read,
        get: <T>(area: string, key: string) => read().areas[area]?.[key] as StateValue<T> | undefined,
        report: (area, key, value) => change(area, key, () => value),
        markStale: (area, key) => change(area, key, (current) => (current ? { ...current, stale: true } : null)),
    };
}

/** A state store in memory, for tests and for runs that must not write (`explain` without `--fresh`). */
export function memoryStateStore(initial: GenesisToolsStateFile = emptyState()): StateStore {
    let state = initial;

    return {
        read: () => state,
        get: <T>(area: string, key: string) => state.areas[area]?.[key] as StateValue<T> | undefined,
        report: async (area, key, value) => {
            state = withValue(state, area, key, value);
        },
        markStale: async (area, key) => {
            const current = state.areas[area]?.[key];
            state = withValue(state, area, key, current ? { ...current, stale: true } : null);
        },
    };
}
