import type { ReactElement, ReactNode } from "react";
import { createSettingsProvider } from "@ui/settings";
import {
    DEFAULT_SESSION_POOL_SETTINGS,
    parseSessionPoolSettings,
    SESSION_POOL_SETTINGS_STORAGE_KEY,
    type SessionPoolSettings,
} from "@/lib/session-pool-settings";

const { Provider, useSettings } = createSettingsProvider<SessionPoolSettings>({
    displayName: "SessionPoolSettings",
    storageKey: SESSION_POOL_SETTINGS_STORAGE_KEY,
    defaults: DEFAULT_SESSION_POOL_SETTINGS,
    parse: parseSessionPoolSettings,
});

export function SessionPoolSettingsProvider({ children }: { children: ReactNode }): ReactElement {
    return <Provider>{children}</Provider>;
}

export function useSessionPoolSettings() {
    return useSettings();
}
