import { useLocation } from "@tanstack/react-router";
import { IconTooltip } from "@ui/components/icon-button";
import { ArrowUpDown } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { NavOrderEditor } from "@/components/NavOrderEditor";
import { isNavRouteActive, NavRailLink } from "@/components/nav-rail-link";
import { useNavOrder } from "@/hooks/useNavOrder";

// @dnd-kit is only worth downloading for a session that actually reorders the rail,
// so the drag layer arrives on the first press of the reorder control or the first
// long press on an icon, never in the initial chunk.
const SidebarSortable = lazy(() =>
    import("@/components/SidebarSortable").then((module) => ({ default: module.SidebarSortable }))
);

const LONG_PRESS_MS = 450;

export function Sidebar() {
    const { pathname } = useLocation();
    const { routes, move } = useNavOrder();
    const [reordering, setReordering] = useState(false);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // A long press that turned into reorder mode must not also follow the link the
    // finger was resting on, so the click it produces is swallowed once.
    const swallowNextClick = useRef(false);

    const cancelLongPress = useCallback(() => {
        if (longPressTimer.current !== null) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);

    const startLongPress = useCallback(() => {
        cancelLongPress();
        // A stale flag from a gesture that never produced a click would eat an
        // unrelated click later, so every new press starts from a clean slate.
        swallowNextClick.current = false;

        if (reordering) {
            return;
        }

        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            swallowNextClick.current = true;
            setReordering(true);
        }, LONG_PRESS_MS);
    }, [cancelLongPress, reordering]);

    useEffect(() => cancelLongPress, [cancelLongPress]);

    useEffect(() => {
        if (!reordering) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setReordering(false);
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [reordering]);

    const icons = routes.map((route) => (
        <NavRailLink key={route.to} route={route} active={isNavRouteActive(route, pathname)} />
    ));

    return (
        <nav className="sticky top-0 flex h-screen flex-col items-center gap-3 overflow-y-auto pb-4 pt-4">
            <div
                className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px]"
                style={{ background: "var(--dd-accent-gradient)", boxShadow: "0 0 14px rgba(52,211,153,0.35)" }}
                aria-label="dev-dashboard"
            />
            <div
                className="flex flex-col items-center gap-3"
                onPointerDown={startLongPress}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onClickCapture={(event) => {
                    if (swallowNextClick.current) {
                        swallowNextClick.current = false;
                        event.preventDefault();
                        event.stopPropagation();
                    }
                }}
            >
                {reordering ? (
                    <Suspense fallback={icons}>
                        <SidebarSortable routes={routes} pathname={pathname} onMove={move} />
                    </Suspense>
                ) : (
                    icons
                )}
            </div>
            <div className="mt-auto flex flex-col items-center gap-2 pt-2">
                <IconTooltip tooltip={reordering ? "Done reordering" : "Drag icons to reorder"}>
                    <button
                        type="button"
                        aria-label={reordering ? "Done reordering" : "Drag icons to reorder"}
                        aria-pressed={reordering}
                        onClick={() => setReordering((on) => !on)}
                        className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] border transition"
                        style={{
                            background: reordering ? "var(--dd-accent-gradient)" : "transparent",
                            borderColor: reordering ? "transparent" : "var(--dd-border)",
                            color: reordering ? "#0c0e10" : "var(--dd-text-secondary)",
                        }}
                    >
                        <ArrowUpDown size={14} />
                    </button>
                </IconTooltip>
                <NavOrderEditor />
            </div>
        </nav>
    );
}
