import type { UserSettings } from "@app/youtube/lib/user-settings";

export type ResolvedTheme = "light" | "dark";

/** Resolve the concrete theme to paint. "system" follows the OS preference. */
export function resolveTheme(theme: UserSettings["theme"], prefersDark: boolean): ResolvedTheme {
    if (theme === "light") {
        return "light";
    }

    if (theme === "dark") {
        return "dark";
    }

    return prefersDark ? "dark" : "light";
}

function prefersDarkNow(): boolean {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return true;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Apply theme + density to the document root. Idempotent — safe to call on every
 * settings change. The app is dark-first (cyberpunk tokens); "light" flips
 * `color-scheme` and marks the root so native controls follow, while density
 * toggles a spacing class.
 */
export function applyAppearance(settings: Pick<UserSettings, "theme" | "density">): void {
    if (typeof document === "undefined") {
        return;
    }

    const resolved = resolveTheme(settings.theme, prefersDarkNow());
    const root = document.documentElement;
    root.dataset.ytTheme = resolved;
    root.style.colorScheme = resolved;
    root.classList.toggle("yt-theme-light", resolved === "light");
    root.classList.toggle("yt-density-compact", settings.density === "compact");
}
