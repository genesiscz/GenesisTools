export interface IdbDumpArgs {
    /** Only this database. A name that does not exist is reported, never created. */
    db?: string;
    /** Only this object store. */
    store?: string;
    /** Only the row with this key. */
    key?: string | number;
    /** Omit values whose JSON is bigger than this many UTF-8 bytes (a preview stays). Default: no cap. */
    maxValueBytes?: number;
    /** Keys and sizes only, no values. */
    keysOnly?: boolean;
}

export interface IdbRow {
    key: unknown;
    /** The value as JSON-safe data: strings stay byte-exact, non-JSON values become `{ $type: ... }` tags. */
    value?: unknown;
    /** UTF-8 bytes of the value's JSON text (a string counts its quotes and escapes). Absent with `keysOnly`. */
    jsonBytes?: number;
    /** UTF-8 bytes of the data itself: a string's own text, any other value's JSON. Absent with `keysOnly`. */
    dataBytes?: number;
    /** Set when `maxValueBytes` cut the value; `preview` holds the first 200 characters of its JSON. */
    truncated?: boolean;
    preview?: string;
}

export interface IdbStoreDump {
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    indexes: string[];
    count: number;
    jsonBytes: number;
    /** Sum of the rows' `dataBytes`. Absent in dumps made before it existed. */
    dataBytes?: number;
    rows: IdbRow[];
    error?: string;
}

export interface IdbDatabaseDump {
    name: string;
    version: number;
    stores: IdbStoreDump[];
    error?: string;
}

export interface IdbDump {
    origin: string;
    databases: IdbDatabaseDump[];
    error?: string;
}

/**
 * Reads every IndexedDB database of the page's origin, read-only: it lists databases first and never
 * opens a name that does not exist (`indexedDB.open` would create it), uses readonly transactions,
 * and closes each connection, also when the app asks for a version change.
 * Self-contained: only its source reaches the page.
 */
export async function idbDump(args: IdbDumpArgs): Promise<IdbDump> {
    const encoder = new TextEncoder();
    const result: IdbDump = { origin: location.origin, databases: [] };

    const plain = (value: unknown, seen: Set<object>): unknown => {
        if (value === null || typeof value === "string" || typeof value === "boolean") {
            return value;
        }

        if (typeof value === "number") {
            return Number.isFinite(value) ? value : { $type: "number", value: String(value) };
        }

        if (value === undefined) {
            return { $type: "undefined" };
        }

        if (typeof value === "bigint") {
            return { $type: "bigint", value: value.toString() };
        }

        if (typeof value !== "object") {
            return { $type: typeof value };
        }

        if (seen.has(value)) {
            return { $type: "cycle" };
        }

        if (value instanceof Date) {
            return { $type: "date", value: Number.isNaN(value.getTime()) ? null : value.toISOString() };
        }

        if (value instanceof RegExp) {
            return { $type: "regexp", value: String(value) };
        }

        if (typeof Blob !== "undefined" && value instanceof Blob) {
            const name = typeof File !== "undefined" && value instanceof File ? value.name : undefined;
            return { $type: "blob", size: value.size, mime: value.type, name };
        }

        if (value instanceof ArrayBuffer) {
            return { $type: "bytes", byteLength: value.byteLength };
        }

        if (ArrayBuffer.isView(value)) {
            return { $type: value.constructor.name, byteLength: value.byteLength };
        }

        seen.add(value);
        try {
            if (value instanceof Map) {
                return {
                    $type: "map",
                    entries: Array.from(value.entries()).map(([k, v]) => [plain(k, seen), plain(v, seen)]),
                };
            }

            if (value instanceof Set) {
                return { $type: "set", values: Array.from(value.values()).map((v) => plain(v, seen)) };
            }

            if (Array.isArray(value)) {
                return value.map((item) => plain(item, seen));
            }

            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = plain(v, seen);
            }

            return out;
        } finally {
            seen.delete(value);
        }
    };

    const request = <T>(req: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

    const open = (name: string): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
            const req = indexedDB.open(name);
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error(`opening ${name} is blocked by another connection`));
            req.onupgradeneeded = () => {
                req.transaction?.abort();
                reject(new Error(`${name} did not exist; the open was aborted so nothing was created`));
            };
        });

    const dumpStore = async (db: IDBDatabase, storeName: string): Promise<IdbStoreDump> => {
        const store = db.transaction(storeName, "readonly").objectStore(storeName);
        const dump: IdbStoreDump = {
            name: storeName,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: Array.from(store.indexNames),
            count: 0,
            jsonBytes: 0,
            dataBytes: 0,
            rows: [],
        };
        const range = args.key === undefined ? undefined : IDBKeyRange.only(args.key);
        const [keys, values] = await Promise.all([
            request(store.getAllKeys(range)),
            args.keysOnly ? Promise.resolve([] as unknown[]) : request(store.getAll(range)),
        ]);
        dump.count = keys.length;
        for (let i = 0; i < keys.length; i++) {
            const row: IdbRow = { key: plain(keys[i], new Set()) };
            if (!args.keysOnly) {
                const value = plain(values[i], new Set());
                // biome-ignore lint/style/noRestrictedGlobals: in-page code runs in the browser and cannot import SafeJSON
                const json = JSON.stringify(value) ?? "null";
                const bytes = encoder.encode(json).length;
                // A stored string is its text; JSON adds quotes and escapes (measured: +12% on a cached query blob).
                const dataBytes = typeof value === "string" ? encoder.encode(value).length : bytes;
                row.jsonBytes = bytes;
                row.dataBytes = dataBytes;
                dump.jsonBytes += bytes;
                dump.dataBytes = (dump.dataBytes ?? 0) + dataBytes;
                if (args.maxValueBytes !== undefined && bytes > args.maxValueBytes) {
                    row.truncated = true;
                    row.preview = json.slice(0, 200);
                } else {
                    row.value = value;
                }
            }

            dump.rows.push(row);
        }

        return dump;
    };

    try {
        const listed = await indexedDB.databases();
        const names = listed.map((info) => ({ name: info.name ?? "", version: info.version ?? 0 }));
        const wanted = args.db === undefined ? names : names.filter((info) => info.name === args.db);
        if (args.db !== undefined && wanted.length === 0) {
            result.error = `no database named ${args.db} on ${location.origin}`;
        }

        for (const info of wanted) {
            const entry: IdbDatabaseDump = { name: info.name, version: info.version, stores: [] };
            result.databases.push(entry);
            let db: IDBDatabase | null = null;
            try {
                db = await open(info.name);
                const stores = Array.from(db.objectStoreNames).filter(
                    (name) => args.store === undefined || name === args.store
                );
                for (const storeName of stores) {
                    try {
                        entry.stores.push(await dumpStore(db, storeName));
                    } catch (error) {
                        entry.stores.push({
                            name: storeName,
                            keyPath: null,
                            autoIncrement: false,
                            indexes: [],
                            count: 0,
                            jsonBytes: 0,
                            dataBytes: 0,
                            rows: [],
                            error: String(error),
                        });
                    }
                }
            } catch (error) {
                entry.error = String(error);
            } finally {
                db?.close();
            }
        }
    } catch (error) {
        result.error = String(error);
    }

    return result;
}
