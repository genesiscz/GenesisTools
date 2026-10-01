import { type CapabilityCheck, hasCapability } from "@genesiscz/utils/browser-router/capabilities";
import { presets } from "@genesiscz/utils/browser-router/presets";
import type { RouteAction, RouteRule } from "@genesiscz/utils/browser-router/route";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

const PATTERN_WIDTH = 48;
const NAME_WIDTH = 22;
const ACTION_WIDTH = 48;

/** One line naming the action's type and what it does, for the routes table and nothing else. */
export function actionSummary(action: RouteAction): string {
    if (action.type === "open") {
        return `open ${action.to}`;
    }

    if (action.type === "forward") {
        const browser = typeof action.browser === "string" ? action.browser : action.browser.name;
        return action.to ? `forward ${browser} ${action.to}` : `forward ${browser}`;
    }

    if (action.type === "unwrap") {
        return "unwrap";
    }

    if (action.type === "token") {
        return "token";
    }

    if (action.type === "tool") {
        return `tool ${[action.tool, ...action.args].join(" ")}`;
    }

    return `run ${action.argv.join(" ")}`;
}

/**
 * Whether this route's preset is available on this Mac. A route with no `preset` tag is the user's
 * own and always counts as available. A preset-tagged route follows its preset's `available`: the
 * same check `install` uses to keep or drop it. The native matcher does not read it, so a saved
 * route whose preset is unavailable still fires until `install` drops it.
 */
export function isEnabled(route: RouteRule, check: CapabilityCheck): boolean {
    if (!route.preset) {
        return true;
    }

    return presets(check).find((preset) => preset.id === route.preset)?.available ?? false;
}

/** Human table for `tools browser-router routes`. The raw array is still available via --format json. */
export function displayRoutesTable(routes: RouteRule[], check: CapabilityCheck = hasCapability): void {
    renderCliHeader("Browser Router Routes", `${routes.length} saved route(s)`);

    if (routes.length === 0) {
        out.println(pc.dim("  No routes saved yet. Save one: tools browser-router route <pattern> --route-to <url>"));
        return;
    }

    const table = createBoxTable(["PATTERN", "NAME", "ACTION", "PRESET", "PRESET AVAILABLE"]);

    for (const route of routes) {
        table.push([
            pc.white(truncateDisplay(route.pattern, PATTERN_WIDTH)),
            truncateDisplay(route.name, NAME_WIDTH),
            truncateDisplay(actionSummary(route.action), ACTION_WIDTH),
            route.preset ? pc.blue(route.preset) : pc.dim("—"),
            isEnabled(route, check) ? formatDotStatus("ok", "yes") : formatDotStatus("warn", "stale"),
        ]);
    }

    out.println(table.toString());
}
