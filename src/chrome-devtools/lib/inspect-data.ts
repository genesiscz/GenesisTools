/** Pure shaping for the `storage` and `react` verbs: dump to table rows, CLI flags to library arguments. */
import type { ReactMatcher } from "@genesiscz/utils/chrome-devtools/libraries/react/find-props";
import type { IdbDump } from "@genesiscz/utils/chrome-devtools/storage";
import { SafeJSON } from "@genesiscz/utils/json";

export interface IdbStoreLine {
    db: string;
    /** null when the database itself could not be opened. */
    store: string | null;
    rows: number;
    /** Data bytes (a string's own text, other values as JSON); null without sizes (`--keys-only`) or on failure. */
    bytes: number | null;
    error?: string;
}

/** One line per object store, plus one for each database that failed before listing its stores. */
export function idbStoreLines(dump: IdbDump): IdbStoreLine[] {
    const lines: IdbStoreLine[] = [];

    for (const db of dump.databases) {
        if (db.error && db.stores.length === 0) {
            lines.push({ db: db.name, store: null, rows: 0, bytes: null, error: db.error });
            continue;
        }

        for (const store of db.stores) {
            const sized = store.rows.length === 0 || store.rows.some((row) => row.jsonBytes !== undefined);
            const line: IdbStoreLine = {
                db: db.name,
                store: store.name,
                rows: store.count,
                bytes: sized ? (store.dataBytes ?? store.jsonBytes) : null,
            };

            if (store.error) {
                line.error = store.error;
            }

            lines.push(line);
        }
    }

    return lines;
}

export interface IdbBigRow {
    db: string;
    store: string;
    key: unknown;
    bytes: number;
    /** The start of the value's JSON, or null when the dump carried no value (`--keys-only`). */
    preview: string | null;
}

/** The largest rows by data bytes, largest first, across every database and store. */
export function biggestIdbRows(dump: IdbDump, limit: number): IdbBigRow[] {
    const rows: IdbBigRow[] = [];

    for (const db of dump.databases) {
        for (const store of db.stores) {
            for (const row of store.rows) {
                if (row.jsonBytes === undefined) {
                    continue;
                }

                const preview =
                    row.preview ?? (row.value === undefined ? null : SafeJSON.stringify(row.value).slice(0, 200));
                rows.push({
                    db: db.name,
                    store: store.name,
                    key: row.key,
                    bytes: row.dataBytes ?? row.jsonBytes,
                    preview,
                });
            }
        }
    }

    return rows.sort((a, z) => z.bytes - a.bytes).slice(0, limit);
}

/**
 * `--key` as an IndexedDB key: digits are a NUMBER key (IndexedDB never equates 42 and "42"),
 * a double-quoted value is a string key, anything else is the string as typed.
 */
export function parseIdbKey(raw: string): string | number {
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
        return Number(raw);
    }

    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
        return raw.slice(1, -1);
    }

    return raw;
}

/** `react find` flags as structured matchers, or the reason they do not make a valid query. */
export function reactMatchersFrom(flags: {
    functions: string[];
    paths: string[];
    component?: string;
    expose?: string;
}): ReactMatcher[] | { error: string } {
    const scope = flags.component ? { component: flags.component } : {};
    const matchers: ReactMatcher[] = [
        ...flags.functions.map((path) => ({ name: path, hasFunction: path, ...scope })),
        ...flags.paths.map((path) => ({ name: path, hasPath: path, ...scope })),
    ];

    if (matchers.length === 0 && flags.component) {
        matchers.push({ name: flags.component, component: flags.component });
    }

    if (matchers.length === 0) {
        return { error: "react find needs at least one --function, --path or --component." };
    }

    if (flags.expose) {
        if (matchers.length !== 1) {
            return {
                error: `--expose names ONE window slot, so it needs exactly one matcher; got ${matchers.length}.`,
            };
        }

        matchers[0].exposeAs = flags.expose;
    }

    return matchers;
}
