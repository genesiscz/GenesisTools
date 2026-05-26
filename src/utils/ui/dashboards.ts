/**
 * Central registry of every web dashboard / UI dev server in this repo.
 *
 * One source of truth for ports, launch commands and metadata. Ports were
 * previously scattered across each tool's `vite.config.ts` / command file with
 * no coordination — `youtube` and `reas` both defaulted to 3072 with
 * `--strictPort`, so launching the second hard-crashed. The conflicting pair
 * now derives its port from here (see `youtube/ui/vite.config.ts`,
 * `youtube/commands/ui.ts`, `Internal/commands/reas/ui/vite.config.ts`); the
 * remaining tools still hardcode their (non-conflicting) port and are tracked
 * here for documentation — wiring them to consume this registry is a safe
 * incremental follow-up.
 *
 * Invariant: every `port` is unique. `findPortConflicts()` is exported so a
 * test (or a launcher) can assert this; keep it green when adding a dashboard.
 */

export type DashboardAuth = "none" | "workos" | "basic-auth";

export type DashboardTech = "vite+tanstack-start" | "vite+tanstack-router" | "vite+tanstack-start+nitro" | "vite";

export interface DashboardEntry {
    /** Stable short id (also the registry key). */
    readonly key: string;
    /** Human-facing title. */
    readonly name: string;
    /** One-line description of what it does. */
    readonly description: string;
    /** Default localhost port the dev server binds. Must be unique. */
    readonly port: number;
    /** Dev-server bind address. Default 127.0.0.1 when omitted. */
    readonly bindHost?: "127.0.0.1" | "0.0.0.0";
    /**
     * Whether the dev server passes `--strictPort` (a port clash is then a
     * hard crash rather than an auto-increment). Relevant to conflict risk.
     */
    readonly strictPort: boolean;
    /** Exact CLI command that launches it, or `null` if it has no entry point. */
    readonly launch: string | null;
    /** Where/how the port can be overridden (env var, CLI flag, or none). */
    readonly portOverride: { readonly env?: string; readonly flag?: string } | null;
    readonly tech: DashboardTech;
    readonly auth: DashboardAuth;
    /** Anything noteworthy (proxy pattern, orphaned, registry-wired, …). */
    readonly note?: string;
}

export const DASHBOARDS = {
    "claude-history": {
        key: "claude-history",
        name: "Claude History Browser",
        description: "Search & browse Claude Code conversation history.",
        port: 3069,
        strictPort: false,
        launch: "tools claude history dashboard",
        portOverride: { flag: "-p, --port" },
        tech: "vite+tanstack-start",
        auth: "none",
    },
    dashboard: {
        key: "dashboard",
        name: "Personal Dashboard",
        description: "Tasks, timers, activity log, focus modes.",
        port: 3000,
        strictPort: false,
        launch: "tools dashboard",
        portOverride: { flag: "-p, --port" },
        tech: "vite+tanstack-start+nitro",
        auth: "workos",
        note: "Launcher wrapper (PM2 + deps); 3000 is the launcher port.",
    },
    "dev-dashboard": {
        key: "dev-dashboard",
        name: "Dev Dashboard",
        description: "Obsidian vault + ttyd terminal + cmux multiplexer.",
        port: 3042,
        bindHost: "0.0.0.0",
        strictPort: true,
        launch: "tools dev-dashboard",
        portOverride: { env: "DEV_DASHBOARD_PUBLIC_PORT" },
        tech: "vite+tanstack-start",
        auth: "basic-auth",
        note: "Front-proxy: Bun.serve on 3042 bridges to Vite on a random loopback port (WebSocket support).",
    },
    clarity: {
        key: "clarity",
        name: "Clarity Timelog",
        description: "Azure DevOps ↔ CA PPM Clarity timesheet sync.",
        port: 3071,
        strictPort: false,
        launch: "tools clarity ui",
        portOverride: null,
        tech: "vite+tanstack-start",
        auth: "none",
    },
    reas: {
        key: "reas",
        name: "REAS Analyzer",
        description: "Real-estate investment analysis (reas.cz + Sreality + MF cenová mapa).",
        port: 3072,
        strictPort: true,
        launch: "tools internal reas --dashboard",
        portOverride: { flag: "--dashboard-port" },
        tech: "vite+tanstack-start",
        auth: "none",
        note: "Port sourced from this registry (vite.config.ts).",
    },
    shops: {
        key: "shops",
        name: "Shops CZ",
        description: "Czech e-shop price intelligence — watchlist, alerts, observability.",
        port: 3073,
        strictPort: true,
        launch: "tools shops ui",
        portOverride: null,
        tech: "vite+tanstack-start",
        auth: "none",
    },
    youtube: {
        key: "youtube",
        name: "YouTube Web UI",
        description: "Browse, search & analyze YouTube videos, channels, transcripts.",
        port: 3074,
        strictPort: true,
        launch: "tools youtube ui",
        portOverride: { env: "YOUTUBE_UI_PORT", flag: "--port" },
        tech: "vite+tanstack-router",
        auth: "none",
        note: "Moved 3072 → 3074 to resolve the reas conflict. Port sourced from this registry.",
    },
    "debugging-master": {
        key: "debugging-master",
        name: "Log Viewer (dbg + task)",
        description: "Unified live log dashboard for debugging-master and task sessions.",
        port: 7243,
        bindHost: "0.0.0.0",
        strictPort: false,
        launch: "tools debugging-master dashboard serve",
        portOverride: { flag: "--port" },
        tech: "vite",
        auth: "none",
        note: "Shared by `tools task dashboard open` and `tools debugging-master dashboard serve open` (latter via the DashboardApp commander).",
    },
} as const satisfies Record<string, DashboardEntry>;

export type DashboardKey = keyof typeof DASHBOARDS;

export function getDashboard(key: DashboardKey): DashboardEntry {
    return DASHBOARDS[key];
}

export function listDashboards(): readonly DashboardEntry[] {
    return Object.values(DASHBOARDS);
}

export function dashboardUrl(key: DashboardKey, host = "localhost"): string {
    const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

    return `http://${normalizedHost}:${DASHBOARDS[key].port}`;
}

/**
 * Groups of dashboards sharing a port. Empty array = no conflicts.
 * Wire into a launcher/test so future additions can't silently re-introduce
 * the youtube/reas-style clash.
 */
export function findPortConflicts(): ReadonlyArray<{ port: number; keys: DashboardKey[] }> {
    const byPort = new Map<number, DashboardKey[]>();

    for (const entry of Object.values(DASHBOARDS)) {
        const keys = byPort.get(entry.port) ?? [];
        keys.push(entry.key as DashboardKey);
        byPort.set(entry.port, keys);
    }

    const conflicts: Array<{ port: number; keys: DashboardKey[] }> = [];
    for (const [port, keys] of byPort) {
        if (keys.length > 1) {
            conflicts.push({ port, keys });
        }
    }

    return conflicts;
}
