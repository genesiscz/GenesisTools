import { useCallback, useEffect, useState } from "react";
import { useDisplaySettings } from "@/components/DisplaySettingsProvider";
import { clearPaneWrapOverride, loadPaneWrapOverrides, setPaneWrapOverride } from "@/lib/pane-display-overrides";

export function usePaneWrapLongLines(paneKey: string | undefined): {
    effective: boolean;
    override: boolean | undefined;
    global: boolean;
    setWrapLongLines: (value: boolean) => void;
    resetToGlobal: () => void;
} {
    const { settings } = useDisplaySettings();
    const [override, setOverride] = useState<boolean | undefined>(() => {
        if (!paneKey) {
            return undefined;
        }

        const overrides = loadPaneWrapOverrides();

        if (paneKey in overrides) {
            return overrides[paneKey];
        }

        return undefined;
    });

    useEffect(() => {
        if (!paneKey) {
            setOverride(undefined);
            return;
        }

        const overrides = loadPaneWrapOverrides();

        if (paneKey in overrides) {
            setOverride(overrides[paneKey]);
            return;
        }

        setOverride(undefined);
    }, [paneKey, settings.wrapLongLines]);

    const effective = override ?? settings.wrapLongLines;

    const setWrapLongLines = useCallback(
        (value: boolean) => {
            if (!paneKey) {
                return;
            }

            setPaneWrapOverride(paneKey, value);
            setOverride(value);
        },
        [paneKey]
    );

    const resetToGlobal = useCallback(() => {
        if (!paneKey) {
            return;
        }

        clearPaneWrapOverride(paneKey);
        setOverride(undefined);
    }, [paneKey]);

    return {
        effective,
        override,
        global: settings.wrapLongLines,
        setWrapLongLines,
        resetToGlobal,
    };
}
