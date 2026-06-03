export type SettingsStoreKind = "localStorage" | "sessionStorage" | "memory";

export interface PersistedSettingsStorage {
    read: (key: string) => string | null;
    write: (key: string, value: string) => void;
}

const memoryStores = new Map<SettingsStoreKind, Map<string, string>>();

function memoryStore(kind: SettingsStoreKind): Map<string, string> {
    let store = memoryStores.get(kind);

    if (!store) {
        store = new Map();
        memoryStores.set(kind, store);
    }

    return store;
}

export function createPersistedSettingsStorage(kind: SettingsStoreKind): PersistedSettingsStorage {
    if (kind === "memory") {
        const store = memoryStore("memory");

        return {
            read: (key) => store.get(key) ?? null,
            write: (key, value) => {
                store.set(key, value);
            },
        };
    }

    if (typeof window === "undefined") {
        const store = memoryStore(kind);

        return {
            read: (key) => store.get(key) ?? null,
            write: (key, value) => {
                store.set(key, value);
            },
        };
    }

    const webStore = kind === "sessionStorage" ? window.sessionStorage : window.localStorage;

    return {
        read: (key) => {
            try {
                return webStore.getItem(key);
            } catch {
                return null;
            }
        },
        write: (key, value) => {
            try {
                webStore.setItem(key, value);
            } catch {
                // storage unavailable
            }
        },
    };
}
