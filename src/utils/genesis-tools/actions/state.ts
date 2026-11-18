import { statSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { DocumentUnreadableError, jsonDocument, prettyJson } from "@genesiscz/utils/storage/locked-document";
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

function isStateValue(value: unknown): value is StateValue {
    return (
        isObject(value) &&
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

    return decodeStateFile(raw);
}

/** The state file from its parsed JSON, keeping only well-formed values; it never throws. */
function decodeStateFile(raw: unknown): GenesisToolsStateFile {
    if (!isObject(raw) || (raw.version !== undefined && raw.version !== 1) || !isObject(raw.areas)) {
        return emptyState();
    }

    const areas: GenesisToolsStateFile["areas"] = {};

    for (const [area, values] of Object.entries(raw.areas)) {
        if (!isObject(values)) {
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

/**
 * The one writer of state.json: every change is a locked read, merge and atomic replace, so a reader never sees half a
 * file. State is a cache of facts: a file that does not parse is replaced, and a missing fact is probed again.
 */
export function createStateStore(options: StateStoreOptions = {}): StateStore {
    const file = options.file ?? genesisToolsStatePath();
    const document = jsonDocument<GenesisToolsStateFile>({
        path: file,
        empty: emptyState,
        decode: decodeStateFile,
        encode: prettyJson,
        strictJson: true,
        onUnreadable: "discard",
    });
    /** The last parse, keyed by the file's identity: every write renames a new file in, so another inode is a change. */
    let cached: { key: string; state: GenesisToolsStateFile } | undefined;

    function read(): GenesisToolsStateFile {
        const stat = statSync(file, { throwIfNoEntry: false });

        if (!stat) {
            return emptyState();
        }

        const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;

        if (cached?.key === key) {
            return cached.state;
        }

        let state: GenesisToolsStateFile;

        try {
            state = document.read();
        } catch (error) {
            if (!(error instanceof DocumentUnreadableError) || error.kind === "io") {
                throw error;
            }

            logger.debug({ error }, "genesis-tools state: unreadable file, starting empty");
            state = emptyState();
        }

        cached = { key, state };
        return state;
    }

    async function change(area: string, key: string, next: (current?: StateValue) => StateValue | null): Promise<void> {
        const written = await document.update((current) => {
            const value = next(current.areas[area]?.[key]);
            return { write: withValue(current, area, key, value), result: value };
        });
        // The value is written; a listener that throws must not tell the caller the report failed.
        try {
            options.onChange?.({ area, key, value: written });
        } catch (error) {
            logger.warn({ error, area, key }, "genesis-tools state: the change listener threw");
        }
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
