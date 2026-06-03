import { createSettingsProvider } from "@ui/settings";
import type { ReactElement, ReactNode } from "react";
import {
    applyDisplaySettings,
    DEFAULT_DISPLAY_SETTINGS,
    DEFAULT_LOG_DISPLAY_SETTINGS,
    DEFAULT_TYPOGRAPHY_SETTINGS,
    DISPLAY_SETTINGS_STORAGE_KEY,
    type DisplaySettings,
    parseDisplaySettings,
} from "@/lib/display-settings";

const { Provider: BaseProvider, useSettings: useBaseDisplaySettings } = createSettingsProvider<DisplaySettings>({
    displayName: "DisplaySettings",
    storageKey: DISPLAY_SETTINGS_STORAGE_KEY,
    defaults: DEFAULT_DISPLAY_SETTINGS,
    parse: parseDisplaySettings,
    onChange: applyDisplaySettings,
});

export function DisplaySettingsProvider({ children }: { children: ReactNode }): ReactElement {
    return <BaseProvider>{children}</BaseProvider>;
}

export function useDisplaySettings() {
    const base = useBaseDisplaySettings();

    return {
        settings: base.settings,
        updateSettings: base.updateSettings,
        resetSettings: base.resetSettings,
        resetTypographySettings: () => {
            base.resetPartial(DEFAULT_TYPOGRAPHY_SETTINGS);
        },
        resetLogSettings: () => {
            base.resetPartial(DEFAULT_LOG_DISPLAY_SETTINGS);
        },
    };
}
