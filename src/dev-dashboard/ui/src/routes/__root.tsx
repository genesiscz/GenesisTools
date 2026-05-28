import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { useLayoutMode } from "@/hooks/useLayoutMode";

interface ShellProps {
    children: ReactNode;
}

export function Shell({ children }: ShellProps) {
    const { pathname } = useLocation();
    const routeKey = pathname.startsWith("/ttyd") ? "ttyd" : pathname.startsWith("/cmux") ? "cmux" : null;
    // useLayoutMode must be called unconditionally; routeKey "" is harmless for
    // non-terminal routes (we only act on the result when routeKey is set).
    const { mode } = useLayoutMode(routeKey ?? "");
    // Focused mode (mobile ≤768 OR desktop toggle) on /ttyd or /cmux owns its
    // own edge nav, so the icon rail is redundant and the page goes edge-to-edge.
    const focused = routeKey !== null && mode === "focused";

    return (
        <div className="dd-grid-bg flex h-full min-h-0 min-w-0 max-w-full overflow-hidden">
            {focused ? null : (
                <aside className="w-[62px] shrink-0 border-r border-[var(--dd-border)] bg-[var(--dd-bg-panel)]">
                    <Sidebar />
                </aside>
            )}
            <main
                className={
                    focused
                        ? "min-h-0 min-w-0 flex-1 overflow-hidden"
                        : "dd-scroll-region min-h-0 min-w-0 flex-1 p-4"
                }
            >
                {children}
            </main>
        </div>
    );
}
