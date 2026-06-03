import { createContext, type ReactElement, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import {
    DEFAULT_SESSION_POOL_SETTINGS,
    loadSessionPoolSettings,
    type SessionPoolSettings,
    saveSessionPoolSettings,
} from "@/lib/session-pool-settings";

interface SessionPoolSettingsContextValue {
    settings: SessionPoolSettings;
    updateSettings: (patch: Partial<SessionPoolSettings>) => void;
    resetSettings: () => void;
}

const SessionPoolSettingsContext = createContext<SessionPoolSettingsContextValue | null>(null);

export function SessionPoolSettingsProvider({ children }: { children: ReactNode }): ReactElement {
    const [settings, setSettings] = useState<SessionPoolSettings>(() => loadSessionPoolSettings());

    useEffect(() => {
        saveSessionPoolSettings(settings);
    }, [settings]);

    const value = useMemo(
        (): SessionPoolSettingsContextValue => ({
            settings,
            updateSettings: (patch) => {
                setSettings((prev) => ({ ...prev, ...patch }));
            },
            resetSettings: () => {
                setSettings(DEFAULT_SESSION_POOL_SETTINGS);
            },
        }),
        [settings]
    );

    return <SessionPoolSettingsContext.Provider value={value}>{children}</SessionPoolSettingsContext.Provider>;
}

export function useSessionPoolSettings(): SessionPoolSettingsContextValue {
    const ctx = useContext(SessionPoolSettingsContext);

    if (!ctx) {
        throw new Error("useSessionPoolSettings must be used within SessionPoolSettingsProvider");
    }

    return ctx;
}
