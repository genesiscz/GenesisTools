import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { DIFF_THRESHOLD_MAX, DIFF_THRESHOLD_MIN } from "./core";
import { checkModeId, DEFAULT_COMPARE_MODE } from "./registry";

/**
 * The page scope of ImageCompare: one mode and one threshold that every comparison under the provider follows until
 * the user picks its own. Both are saved in localStorage, so a reload keeps the page as the user left it.
 */

export const IMAGE_COMPARE_STORAGE_KEY = "artifact.image-compare";

export interface ImageCompareProviderProps {
    /** localStorage key prefix; give each page its own when several pages share an origin. */
    storageKey?: string;
    /** The page mode until the user picks one (default "side-by-side"). */
    defaultMode?: string;
    children: ReactNode;
}

export interface ImageComparePage {
    storageKey: string;
    /** The provider's defaultMode. */
    defaultMode: string;
    /** The mode the user picked on the page switch, if any. It wins over a comparison's own defaultMode. */
    pickedMode: string | undefined;
    setMode: (mode: string) => void;
    /** The threshold the user picked on the page switch, if any. */
    threshold: number | undefined;
    setThreshold: (threshold: number) => void;
}

const ImageCompareContext = createContext<ImageComparePage | null>(null);

/** Used when localStorage is blocked (a sandboxed file:// page, private mode). */
const memoryStore = new Map<string, string>();

export function readStored(key: string): string | undefined {
    try {
        return window.localStorage.getItem(key) ?? memoryStore.get(key);
    } catch {
        // Storage blocked: the in-memory copy below still holds for this page.
        return memoryStore.get(key);
    }
}

export function writeStored(key: string, value: string | undefined): void {
    if (value === undefined) {
        memoryStore.delete(key);
    } else {
        memoryStore.set(key, value);
    }

    try {
        if (value === undefined) {
            window.localStorage.removeItem(key);
        } else {
            window.localStorage.setItem(key, value);
        }
    } catch {
        // Storage blocked or full: the in-memory copy above keeps the choice for this page.
    }
}

/** A stored threshold, or undefined when nothing valid is stored. */
export function parseStoredThreshold(value: string | undefined): number | undefined {
    const parsed = value === undefined ? Number.NaN : Number(value);

    return Number.isFinite(parsed) && parsed >= DIFF_THRESHOLD_MIN && parsed <= DIFF_THRESHOLD_MAX ? parsed : undefined;
}

export function ImageCompareProvider({
    storageKey = IMAGE_COMPARE_STORAGE_KEY,
    defaultMode = DEFAULT_COMPARE_MODE,
    children,
}: ImageCompareProviderProps) {
    checkModeId(defaultMode, "defaultMode");
    const modeKey = `${storageKey}:mode`;
    const thresholdKey = `${storageKey}:threshold`;
    const [pickedMode, setPickedMode] = useState(() => readStored(modeKey));
    const [threshold, setPageThreshold] = useState(() => parseStoredThreshold(readStored(thresholdKey)));

    const value = useMemo<ImageComparePage>(
        () => ({
            storageKey,
            defaultMode,
            pickedMode,
            setMode: (mode) => {
                setPickedMode(mode);
                writeStored(modeKey, mode);
            },
            threshold,
            setThreshold: (next) => {
                setPageThreshold(next);
                writeStored(thresholdKey, String(next));
            },
        }),
        [storageKey, defaultMode, pickedMode, threshold, modeKey, thresholdKey]
    );

    return <ImageCompareContext.Provider value={value}>{children}</ImageCompareContext.Provider>;
}

/** The page scope, or null outside an ImageCompareProvider (a comparison then works alone). */
export function useImageCompare(): ImageComparePage | null {
    return useContext(ImageCompareContext);
}
