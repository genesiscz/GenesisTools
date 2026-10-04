import { cn } from "@ui/lib/utils";
import { useDashboardTheme } from "@ui/theme/dashboard-theme";
import { Palette } from "lucide-react";
import type { DashboardKey } from "../dashboards";

/**
 * Header toggle between the dashboard's registry look and `gold-bento`, saved per dashboard
 * in this browser. A dashboard whose registry look already is `gold-bento` toggles to `cyberpunk`.
 */
export function ThemeSwitch({ themeKey, className }: { themeKey: DashboardKey; className?: string }) {
    const { theme, classic, setTheme } = useDashboardTheme(themeKey);
    const alternate = classic === "gold-bento" ? "cyberpunk" : "gold-bento";
    const next = theme === alternate ? classic : alternate;
    const label = next === "gold-bento" ? "Gold" : next === "native" ? "Classic" : "Cyber";

    return (
        <button
            type="button"
            onClick={() => setTheme(next)}
            title={`Switch to the ${next} look`}
            aria-label={`Switch to the ${next} look`}
            className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background/40 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground hover:border-primary/40",
                className
            )}
        >
            <Palette className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{label}</span>
        </button>
    );
}
