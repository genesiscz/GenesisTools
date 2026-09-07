import { Link } from "@tanstack/react-router";
import { IconTooltip } from "@ui/components/icon-button";
import type { NavRoute } from "@/lib/nav-routes";

/** The rail's active-route rule, shared so the static and sortable rails agree. */
export function isNavRouteActive(route: NavRoute, pathname: string): boolean {
    return route.exact ? pathname === route.to : pathname.startsWith(route.to);
}

interface NavRailLinkProps {
    route: NavRoute;
    active: boolean;
    /**
     * `-1` when something outside already owns the Tab stop for this icon. The
     * sortable rail wraps the link in the drag activator, which dnd-kit gives
     * `role="button"` and `tabIndex=0`; leaving the link focusable too would put
     * two stops and two conflicting roles on one icon.
     */
    tabIndex?: number;
}

/**
 * One icon in the sidebar rail. Lives in its own module so the lazily loaded
 * sortable rail can render exactly the same icon without pulling Sidebar (and
 * therefore its own lazy import) back into the drag chunk.
 */
export function NavRailLink({ route, active, tabIndex }: NavRailLinkProps) {
    const { to, label, Icon } = route;

    return (
        <IconTooltip tooltip={label}>
            <Link
                to={to}
                tabIndex={tabIndex}
                className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] border transition"
                style={{
                    background: active ? "var(--dd-accent-gradient)" : "transparent",
                    borderColor: active ? "transparent" : "var(--dd-border)",
                    color: active ? "#0c0e10" : "var(--dd-text-secondary)",
                }}
            >
                <Icon size={14} />
            </Link>
        </IconTooltip>
    );
}
