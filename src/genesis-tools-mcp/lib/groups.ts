import type { ToolGroupRow } from "@genesiscz/utils/mcp/tool-group";

/**
 * The tool groups this server mounts beside its own tools, one row each. A new group is one row here plus the group
 * module's `toolGroup()`; the capability matcher, the lazy load, the registry cache key and the close come from the
 * row. Each `load` imports its tool only when a capability list can expose the group.
 */
export const TOOL_GROUPS: readonly ToolGroupRow[] = [
    {
        // The evaluation stack (about 80 MB resident, measured 2026-10-01).
        id: "jev",
        prefix: "jev_",
        optIn: false,
        load: () => import("@app/jev/mcp/genesis-tools").then((m) => m.toolGroup()),
    },
    {
        // The native runner and the plan and workflow runners.
        id: "control",
        prefix: "control_",
        optIn: false,
        load: () => import("@app/control/mcp/genesis-tools").then((m) => m.toolGroup()),
    },
    {
        // The HTML converter; a curl worker starts on the first chrome request.
        id: "fetch",
        prefix: "fetch_",
        optIn: false,
        load: () => import("@app/fetch/mcp/genesis-tools").then((m) => m.toolGroup()),
    },
    {
        // An unofficial Alza.cz client with sign-in, basket and orders: most hosts have no use for a shop's 40 tools.
        id: "alza",
        prefix: "alza_",
        optIn: true,
        load: () => import("@app/alza/mcp/genesis-tools").then((m) => m.toolGroup()),
    },
    {
        // Live Waze reports read through a live-map tab in the user's Brave over CDP: it drives the user's real browser.
        id: "waze",
        prefix: "waze_",
        optIn: true,
        load: () => import("@app/waze/mcp/genesis-tools").then((m) => m.toolGroup()),
    },
    {
        // The limits store, the forecast and the rankers.
        id: "usage",
        prefix: "usage_",
        optIn: false,
        load: () => import("@app/ai/mcp/genesis-tools").then((m) => m.toolGroup()),
    },
];
