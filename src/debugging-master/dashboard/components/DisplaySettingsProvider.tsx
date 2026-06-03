import { createContext, type ReactElement, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import {
    applyDisplaySettings,
    DEFAULT_DISPLAY_SETTINGS,
    DEFAULT_LOG_DISPLAY_SETTINGS,
    type DisplaySettings,
    loadDisplaySettings,
    saveDisplaySettings,
} from "@/lib/display-settings";

interface DisplaySettingsContextValue {
    settings: DisplaySettings;
    updateSettings: (patch: Partial<DisplaySettings>) => void;
    resetSettings: () => void;
    resetLogSettings: () => void;
}

const DisplaySettingsContext = createContext<DisplaySettingsContextValue | null>(null);

export function DisplaySettingsProvider({ children }: { children: ReactNode }): ReactElement {
    const [settings, setSettings] = useState<DisplaySettings>(() => {
        const loaded = loadDisplaySettings();
        applyDisplaySettings(loaded);
        return loaded;
    });

    useEffect(() => {
        applyDisplaySettings(settings);
        saveDisplaySettings(settings);
    }, [settings]);

    const value = useMemo(
        (): DisplaySettingsContextValue => ({
            settings,
            updateSettings: (patch) => {
                setSettings((prev) => ({ ...prev, ...patch }));
            },
            resetSettings: () => {
                setSettings(DEFAULT_DISPLAY_SETTINGS);
            },
            resetLogSettings: () => {
                setSettings((prev) => ({ ...prev, ...DEFAULT_LOG_DISPLAY_SETTINGS }));
            },
        }),
        [settings]
    );

    return <DisplaySettingsContext.Provider value={value}>{children}</DisplaySettingsContext.Provider>;
}

export function useDisplaySettings(): DisplaySettingsContextValue {
    const ctx = useContext(DisplaySettingsContext);

    if (!ctx) {
        throw new Error("useDisplaySettings must be used within DisplaySettingsProvider");
    }

    return ctx;
}
