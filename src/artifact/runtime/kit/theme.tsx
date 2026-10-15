import { useEffect, useState, useSyncExternalStore } from "react";
import { onColorSchemeChange, resolvedColorScheme } from "./mermaid-core";
import { SegmentedControl } from "./primitives";

/**
 * Light and dark. The `auto` template writes every token with light-dark(), so
 * the system preference decides and nothing here is needed for that. This
 * module is the opt-in override: `ThemeToggle` stores a choice, sets
 * `data-theme` on the root element, and the pre-paint script in the page
 * chrome applies the stored choice before the first frame. A template that
 * fixes one color-scheme ignores the override.
 */

export { onColorSchemeChange, resolveCssColor, resolvedColorScheme } from "./mermaid-core";

export type ThemeMode = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "artifact-theme";

/** Used when localStorage is blocked (a sandboxed file:// page, private mode). */
let memoryMode: ThemeMode = "system";
const modeListeners = new Set<() => void>();

function isThemeMode(value: unknown): value is ThemeMode {
    return value === "system" || value === "light" || value === "dark";
}

/** The stored choice, or "system". */
export function readThemeMode(): ThemeMode {
    try {
        const stored = window.localStorage.getItem(THEME_STORAGE_KEY);

        return isThemeMode(stored) ? stored : memoryMode;
    } catch {
        return memoryMode;
    }
}

/** Store the choice and apply it to the root element now. */
export function writeThemeMode(mode: ThemeMode): void {
    memoryMode = mode;

    try {
        if (mode === "system") {
            window.localStorage.removeItem(THEME_STORAGE_KEY);
        } else {
            window.localStorage.setItem(THEME_STORAGE_KEY, mode);
        }
    } catch {
        // Storage blocked: the in-memory choice above still holds for this page.
    }

    const root = document.documentElement;

    if (mode === "system") {
        root.removeAttribute("data-theme");
    } else {
        root.setAttribute("data-theme", mode);
    }

    for (const listener of modeListeners) {
        listener();
    }
}

function subscribeMode(listener: () => void): () => void {
    modeListeners.add(listener);

    return () => {
        modeListeners.delete(listener);
    };
}

/** Current choice and the scheme it resolves to. Re-renders when the system setting changes. */
export function useTheme(): { mode: ThemeMode; resolved: "light" | "dark"; setMode: (mode: ThemeMode) => void } {
    const mode = useSyncExternalStore(subscribeMode, readThemeMode, () => "system" as ThemeMode);
    const [resolved, setResolved] = useState<"light" | "dark">(() =>
        typeof document === "undefined" ? "dark" : resolvedColorScheme()
    );

    useEffect(() => {
        setResolved(resolvedColorScheme());

        return onColorSchemeChange(() => setResolved(resolvedColorScheme()));
    }, []);

    return { mode, resolved, setMode: writeThemeMode };
}

/**
 * A counter that ticks on every colour-scheme flip. Components that paint
 * with RESOLVED colours (canvas, computed contrast) read it to repaint.
 */
export function useColorSchemeTick(): number {
    const [tick, setTick] = useState(0);

    useEffect(() => onColorSchemeChange(() => setTick((n) => n + 1)), []);

    return tick;
}

const MODE_OPTIONS = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
];

export interface ThemeToggleProps {
    label?: string;
}

/** System, Light, Dark. Opt-in: no template renders it by itself. It only changes pages on the `auto` template. */
export function ThemeToggle({ label = "Theme" }: ThemeToggleProps) {
    const { mode, setMode } = useTheme();

    return (
        <SegmentedControl
            label={label}
            options={MODE_OPTIONS}
            value={mode}
            onChange={(next) => {
                if (isThemeMode(next)) {
                    setMode(next);
                }
            }}
        />
    );
}
