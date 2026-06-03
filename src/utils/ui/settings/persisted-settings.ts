import { SafeJSON } from "@app/utils/json";
import {
    createPersistedSettingsStorage,
    type PersistedSettingsStorage,
    type SettingsStoreKind,
} from "./persisted-settings-store";

export interface PersistedSettingsOptions<T> {
    storageKey: string;
    store?: SettingsStoreKind;
    defaults: T;
    parse: (raw: unknown) => T;
    storage?: PersistedSettingsStorage;
}

function resolveStorage(options: PersistedSettingsOptions<unknown>): PersistedSettingsStorage {
    if (options.storage) {
        return options.storage;
    }

    return createPersistedSettingsStorage(options.store ?? "localStorage");
}

export function loadPersistedSettings<T>(options: PersistedSettingsOptions<T>): T {
    const storage = resolveStorage(options);

    try {
        const raw = storage.read(options.storageKey);

        if (!raw) {
            return options.defaults;
        }

        return options.parse(SafeJSON.parse(raw));
    } catch {
        return options.defaults;
    }
}

export function savePersistedSettings<T>(options: PersistedSettingsOptions<T>, settings: T): void {
    const storage = resolveStorage(options);

    try {
        storage.write(options.storageKey, SafeJSON.stringify(settings));
    } catch {
        // storage unavailable
    }
}
