import { useEffect } from "react";
import { useSettings } from "@/lib/hooks/useSettings";

/**
 * Applies the persisted `theme` setting to <html> as the `.dark` class
 * (Tailwind v4 `@custom-variant dark (&:is(.dark *))`). "system" follows the
 * OS `prefers-color-scheme`. Effect-only — SSR-safe.
 */
export function useApplyTheme(): void {
    const { settings } = useSettings();

    useEffect(() => {
        const root = document.documentElement;
        const apply = (dark: boolean) => {
            root.classList.toggle("dark", dark);
        };

        if (settings.theme === "system") {
            const mq = window.matchMedia("(prefers-color-scheme: dark)");
            const handler = () => apply(mq.matches);
            handler();
            mq.addEventListener("change", handler);
            return () => mq.removeEventListener("change", handler);
        }

        apply(settings.theme === "dark");
    }, [settings.theme]);
}
