import { createContext, type ReactElement, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { loadPersistedSettings, savePersistedSettings } from "./persisted-settings";
import type { SettingsStoreKind } from "./persisted-settings-store";

export interface SettingsContextValue<T> {
    settings: T;
    updateSettings: (patch: Partial<T>) => void;
    resetSettings: () => void;
    resetPartial: (patch: Partial<T>) => void;
}

export interface CreateSettingsProviderConfig<T> {
    displayName: string;
    storageKey: string;
    store?: SettingsStoreKind;
    defaults: T;
    parse: (raw: unknown) => T;
    onChange?: (settings: T) => void;
}

export function createSettingsProvider<T>(config: CreateSettingsProviderConfig<T>): {
    Provider: ({ children }: { children: ReactNode }) => ReactElement;
    useSettings: () => SettingsContextValue<T>;
} {
    const Context = createContext<SettingsContextValue<T> | null>(null);
    const persistOptions = {
        storageKey: config.storageKey,
        store: config.store,
        defaults: config.defaults,
        parse: config.parse,
    };

    function Provider({ children }: { children: ReactNode }): ReactElement {
        const [settings, setSettings] = useState<T>(() => {
            const loaded = loadPersistedSettings(persistOptions);

            if (config.onChange) {
                config.onChange(loaded);
            }

            return loaded;
        });

        useEffect(() => {
            if (config.onChange) {
                config.onChange(settings);
            }

            savePersistedSettings(persistOptions, settings);
        }, [settings]);

        const value = useMemo(
            (): SettingsContextValue<T> => ({
                settings,
                updateSettings: (patch) => {
                    setSettings((prev) => ({ ...prev, ...patch }));
                },
                resetSettings: () => {
                    setSettings(config.defaults);
                },
                resetPartial: (patch) => {
                    setSettings((prev) => ({ ...prev, ...patch }));
                },
            }),
            [settings]
        );

        return <Context.Provider value={value}>{children}</Context.Provider>;
    }

    Provider.displayName = `${config.displayName}Provider`;

    function useSettings(): SettingsContextValue<T> {
        const ctx = useContext(Context);

        if (!ctx) {
            throw new Error(`useSettings must be used within ${config.displayName}Provider`);
        }

        return ctx;
    }

    return { Provider, useSettings };
}
