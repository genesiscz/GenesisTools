import { loadPersistedSettings, savePersistedSettings } from "@ui/settings";

const STORAGE_KEY = "dbg.paneWrapOverrides";

const persistOptions = {
    storageKey: STORAGE_KEY,
    defaults: {} as Record<string, boolean>,
    parse: (raw: unknown): Record<string, boolean> => {
        if (!raw || typeof raw !== "object") {
            return {};
        }

        const out: Record<string, boolean> = {};

        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof value === "boolean") {
                out[key] = value;
            }
        }

        return out;
    },
};

export function loadPaneWrapOverrides(): Record<string, boolean> {
    return loadPersistedSettings(persistOptions);
}

export function setPaneWrapOverride(paneKey: string, value: boolean): void {
    const current = loadPaneWrapOverrides();
    savePersistedSettings(persistOptions, { ...current, [paneKey]: value });
}

export function clearPaneWrapOverride(paneKey: string): void {
    const current = { ...loadPaneWrapOverrides() };
    delete current[paneKey];
    savePersistedSettings(persistOptions, current);
}

export function clearAllPaneWrapOverrides(): void {
    savePersistedSettings(persistOptions, {});
}

export function resolveWrapLongLines(global: boolean, paneKey: string | undefined): boolean {
    if (!paneKey) {
        return global;
    }

    const overrides = loadPaneWrapOverrides();

    if (paneKey in overrides) {
        return overrides[paneKey] ?? global;
    }

    return global;
}
