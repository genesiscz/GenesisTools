import { useCallback, useEffect, useSyncExternalStore } from "react";
import { env } from "../../env.client";
import { type DashboardKey, type DashboardThemeName, getDashboard } from "../dashboards";

/**
 * Which look a dashboard wears, decided per dashboard. Highest wins:
 *
 * 1. `?theme=<name>` in the URL (one visit; the header switch clears it),
 * 2. the header switch on this page (kept in memory, so it works when localStorage is blocked),
 * 3. the header switch, saved per dashboard in localStorage,
 * 4. `VITE_GT_UI_THEME=<name>` in the dev server's environment (run one server per look),
 * 5. the `theme` field of the dashboard's entry in `DASHBOARDS` (`src/utils/ui/dashboards.ts`).
 *
 * `resolveDashboardTheme` is that rule with the browser taken out; the rest of this file feeds it.
 *
 * `native` means no theme class at all: the app keeps whatever its own CSS paints.
 */
export const DASHBOARD_THEMES = ["native", "cyberpunk", "gold-bento"] as const satisfies readonly DashboardThemeName[];

/** Every class a theme can put on the document; the sync removes all of them before adding one. */
const THEME_CLASSES = ["cyberpunk", "gold-bento"] as const;

const STORAGE_PREFIX = "gt-ui-theme:";

/** Replaced by `createDashboardViteConfig` with the server's `VITE_GT_UI_THEME`; absent elsewhere. */
declare const __GT_UI_THEME__: string | undefined;

function builtTheme(): string | undefined {
    return typeof __GT_UI_THEME__ === "string" ? __GT_UI_THEME__ : env.ui.getTheme();
}

export function isDashboardTheme(value: unknown): value is DashboardThemeName {
    return typeof value === "string" && (DASHBOARD_THEMES as readonly string[]).includes(value);
}

/** The look the dashboard ships with, before anything in the browser changes it. */
export function serverDashboardTheme(key: DashboardKey): DashboardThemeName {
    const fromEnv = builtTheme();
    if (isDashboardTheme(fromEnv)) {
        return fromEnv;
    }

    return classicDashboardTheme(key);
}

/** The registry's choice, i.e. what the switch returns to from `gold-bento`. */
export function classicDashboardTheme(key: DashboardKey): DashboardThemeName {
    return getDashboard(key).theme ?? "native";
}

export function themeClassName(theme: DashboardThemeName): string {
    return theme === "native" ? "" : theme;
}

/** Every source of a dashboard's theme, in the order `resolveDashboardTheme` reads them. */
export interface DashboardThemeSources {
    /** `?theme=` on this visit. */
    url: string | null;
    /** The header switch's choice on this page. */
    picked: DashboardThemeName | undefined;
    /** The header switch's choice saved in localStorage. */
    stored: string | null;
    /** What the server ships (`serverDashboardTheme`). */
    server: DashboardThemeName;
}

/** The precedence rule. A value that names no theme falls through to the next source. */
export function resolveDashboardTheme({ url, picked, stored, server }: DashboardThemeSources): DashboardThemeName {
    if (isDashboardTheme(url)) {
        return url;
    }

    if (picked) {
        return picked;
    }

    if (isDashboardTheme(stored)) {
        return stored;
    }

    return server;
}

const listeners = new Set<() => void>();

/** This page's choice, so the switch still works when localStorage is blocked (private mode, policy). */
const chosen = new Map<DashboardKey, DashboardThemeName>();

function readStoredTheme(key: DashboardKey): string | null {
    try {
        return window.localStorage.getItem(STORAGE_PREFIX + key);
    } catch (error) {
        console.debug("[dashboard-theme] localStorage unavailable", error);
        return null;
    }
}

/** The theme one dashboard shows in this browser; without a browser (SSR), what the server ships. */
export function readDashboardTheme(key: DashboardKey): DashboardThemeName {
    const server = serverDashboardTheme(key);
    if (typeof window === "undefined") {
        return server;
    }

    return resolveDashboardTheme({
        url: new URLSearchParams(window.location.search).get("theme"),
        picked: chosen.get(key),
        stored: readStoredTheme(key),
        server,
    });
}

/** What the header switch does: remember the choice, drop a `?theme=` override, notify every subscriber. */
export function writeDashboardTheme(key: DashboardKey, theme: DashboardThemeName): void {
    chosen.set(key, theme);

    try {
        window.localStorage.setItem(STORAGE_PREFIX + key, theme);
    } catch (error) {
        console.debug("[dashboard-theme] could not save the theme", error);
    }

    const url = new URL(window.location.href);
    if (url.searchParams.has("theme")) {
        url.searchParams.delete("theme");
        window.history.replaceState(window.history.state, "", url);
    }

    for (const notify of listeners) {
        notify();
    }
}

export function subscribeDashboardTheme(notify: () => void): () => void {
    listeners.add(notify);
    return () => listeners.delete(notify);
}

/** Puts exactly one theme class on <html>, so nested shells and the page agree. */
export function syncDocumentClass(
    theme: DashboardThemeName,
    root: { classList: Pick<DOMTokenList, "add" | "remove"> } = document.documentElement
): void {
    root.classList.remove(...THEME_CLASSES);

    const cls = themeClassName(theme);
    if (cls) {
        root.classList.add(cls);
    }
}

export interface DashboardThemeState {
    theme: DashboardThemeName;
    /** Class for a themed subtree, such as the shell or `<body>` (empty for `native`). */
    className: string;
    /**
     * Class for `<html>`: what the server ships, so the SSR markup is themed. It never changes on the
     * client, so React never rewrites the `<html>` class attribute; the hook moves the theme class with
     * `classList` instead, which keeps classes other code adds there (such as `dark`).
     */
    documentClassName: string;
    /** The registry's look; the switch toggles between it and `gold-bento`. */
    classic: DashboardThemeName;
    setTheme: (theme: DashboardThemeName) => void;
}

/**
 * Current theme for one dashboard. Call it once in the root (it keeps <html> in sync);
 * any other caller, such as the header switch, shares the same state.
 */
export function useDashboardTheme(key: DashboardKey): DashboardThemeState {
    const theme = useSyncExternalStore(
        subscribeDashboardTheme,
        () => readDashboardTheme(key),
        () => serverDashboardTheme(key)
    );

    useEffect(() => {
        syncDocumentClass(theme);
    }, [theme]);

    const setTheme = useCallback((next: DashboardThemeName) => writeDashboardTheme(key, next), [key]);

    return {
        theme,
        className: themeClassName(theme),
        documentClassName: themeClassName(serverDashboardTheme(key)),
        classic: classicDashboardTheme(key),
        setTheme,
    };
}
