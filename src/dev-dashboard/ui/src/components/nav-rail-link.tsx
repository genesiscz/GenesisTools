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
}

/**
 * One icon in the sidebar rail. Lives in its own module so the lazily loaded
 * sortable rail can render exactly the same icon without pulling Sidebar (and
 * therefore its own lazy import) back into the drag chunk.
 */
export function NavRailLink({ route, active }: NavRailLinkProps) {
    const { to, label, Icon } = route;

    return (
        <IconTooltip tooltip={label}>
            <Link
                to={to}
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
