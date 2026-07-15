/**
 * Central registry of GenesisTools-owned localhost binds.
 *
 * - `DASHBOARDS` — browser UIs (Vite etc.), consumed by DashboardApp launchers.
 * - `WEB_SERVICES` — non-UI HTTP/API/extension listeners (youtube server, ai-proxy, …).
 *
 * Every entry has a `matchProcess` callback so port scanners can verify the live
 * process is really this app (not a stolen port). Invariant: every `port` is unique
 * across BOTH registries — `findPortConflicts()` asserts this.
 */

export type DashboardAuth = "none" | "workos" | "basic-auth";

export type DashboardTech = "vite+tanstack-start" | "vite+tanstack-router" | "vite+tanstack-start+nitro" | "vite";

export type WebServiceKind = "http-api" | "extension" | "proxy" | "other";

/** Live process fields available when matching a listening port. */
export interface PortMatchContext {
    readonly port: number;
    /** Short process name (lsof COMMAND or basename of argv0). */
    readonly command: string;
    /** Full argv from `ps`, when resolved. */
    readonly fullCommand?: string;
    /** Process cwd, when resolved. */
    readonly cwd?: string;
}

/**
 * Return true if the live process is really this registered app.
 * Port identity is checked by the caller; this only validates process shape.
 */
export type PortProcessMatcher = (ctx: PortMatchContext) => boolean;

/** Shared fields for dashboards and web services. */
export interface PortRegistryBase {
    /** Stable short id (also the registry key). */
    readonly key: string;
    /** Human-facing title (shown in port scanners). */
    readonly name: string;
    /** One-line description of what it does. */
    readonly description: string;
    /** Default localhost port. Must be unique across DASHBOARDS + WEB_SERVICES. */
    readonly port: number;
    /** Exact CLI command that launches it, or `null` if none. */
    readonly launch: string | null;
    /** Where/how the port can be overridden (env var, CLI flag, or none). */
    readonly portOverride: { readonly env?: string; readonly flag?: string } | null;
    /** Anything noteworthy. */
    readonly note?: string;
    /**
     * Verify the live process is this app. Called only when `ctx.port === entry.port`.
     * Prefer path/argv needles over bare package names.
     */
    readonly matchProcess: PortProcessMatcher;
}

export interface DashboardEntry extends PortRegistryBase {
    /** Dev-server bind address. Default 127.0.0.1 when omitted. */
    readonly bindHost?: "127.0.0.1" | "0.0.0.0";
    /**
     * Whether the dev server passes `--strictPort` (a port clash is then a
     * hard crash rather than an auto-increment).
     */
    readonly strictPort: boolean;
    readonly tech: DashboardTech;
    readonly auth: DashboardAuth;
}

export interface WebServiceEntry extends PortRegistryBase {
    readonly serviceKind: WebServiceKind;
}

// ---------------------------------------------------------------------------
// Match helpers (reusable needles for matchProcess)
// ---------------------------------------------------------------------------

function haystack(ctx: PortMatchContext): string {
    return `${ctx.fullCommand ?? ""} ${ctx.cwd ?? ""} ${ctx.command}`.toLowerCase();
}

/** True if haystack contains every needle (AND). */
export function matchAll(...needles: string[]): PortProcessMatcher {
    const lower = needles.map((n) => n.toLowerCase());
    return (ctx) => {
        const h = haystack(ctx);
        return lower.every((n) => h.includes(n));
    };
}

/** True if haystack contains at least one needle (OR). */
export function matchAny(...needles: string[]): PortProcessMatcher {
    const lower = needles.map((n) => n.toLowerCase());
    return (ctx) => {
        const h = haystack(ctx);
        return lower.some((n) => h.includes(n));
    };
}

/**
 * Process lives under the GenesisTools monorepo tree AND matches any of `toolNeedles`.
 * Primary verifier for repo-owned tools.
 */
export function matchGenesisTool(...toolNeedles: string[]): PortProcessMatcher {
    const tools = toolNeedles.map((n) => n.toLowerCase());
    return (ctx) => {
        const h = haystack(ctx);
        const underRepo =
            h.includes("/genesistools/") ||
            h.includes("/genesistools ") ||
            h.endsWith("/genesistools") ||
            h.includes("\\genesistools\\") ||
            h.includes("/genesis-tools/");
        if (!underRepo) {
            return false;
        }

        if (tools.length === 0) {
            return true;
        }

        return tools.some((n) => h.includes(n));
    };
}

// ---------------------------------------------------------------------------
// Dashboards (browser UIs)
// ---------------------------------------------------------------------------

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
        matchProcess: matchGenesisTool("claude-history", "claude/history", "history dashboard"),
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
        matchProcess: matchGenesisTool("src/dashboard", "tools dashboard", "/dashboard/"),
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
        matchProcess: matchGenesisTool("dev-dashboard"),
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
        matchProcess: matchGenesisTool("clarity"),
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
        matchProcess: matchGenesisTool("reas"),
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
        matchProcess: matchGenesisTool("shops"),
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
        matchProcess: matchGenesisTool("youtube/ui", "youtube ui", "src/youtube/ui"),
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
        matchProcess: matchGenesisTool("debugging-master", "log-dashboard", "task/dashboard"),
    },
    "dev-dashboard-cloud": {
        key: "dev-dashboard-cloud",
        name: "DevDashboard Cloud",
        description: "Managed-tier marketing landing + signup + customer dashboard (provisioning, billing).",
        port: 7251,
        strictPort: false,
        launch: "tools dev-dashboard-cloud",
        portOverride: { env: "DD_CLOUD_PORT", flag: "-p, --port" },
        tech: "vite+tanstack-start+nitro",
        auth: "none",
        note: "Auth is Better-Auth + SQLite. App in DevDashboard/cloud/web.",
        matchProcess: matchGenesisTool("dev-dashboard-cloud", "devdashboard/cloud", "dd_cloud"),
    },
} as const satisfies Record<string, DashboardEntry>;

export type DashboardKey = keyof typeof DASHBOARDS;

// ---------------------------------------------------------------------------
// Web services (non-UI HTTP / extension / proxy)
// ---------------------------------------------------------------------------

export const WEB_SERVICES = {
    "youtube-server": {
        key: "youtube-server",
        name: "YouTube Server",
        description: "YouTube tool backend API + pipeline (Bun).",
        port: 9876,
        launch: "tools youtube server",
        portOverride: { flag: "--port" },
        serviceKind: "http-api",
        note: "Default in src/youtube/lib/server/app.ts.",
        matchProcess: matchGenesisTool("youtube/lib/server", "youtube/server", "src/youtube/lib/server"),
    },
    "youtube-extension": {
        key: "youtube-extension",
        name: "YouTube Extension",
        description: "Chrome extension dev reload / bridge port.",
        port: 9877,
        launch: "tools youtube extension dev",
        portOverride: null,
        serviceKind: "extension",
        note: "DEV_RELOAD_PORT in src/youtube/commands/extension.ts.",
        matchProcess: matchGenesisTool("youtube", "extension"),
    },
    "ai-proxy": {
        key: "ai-proxy",
        name: "AI Proxy",
        description: "Local multi-provider AI proxy (billing, accounts, tunnel).",
        port: 8317,
        launch: "tools ai-proxy serve",
        portOverride: { flag: "--port" },
        serviceKind: "proxy",
        note: "Default listen.port in ai-proxy config-store.",
        matchProcess: matchGenesisTool("ai-proxy"),
    },
} as const satisfies Record<string, WebServiceEntry>;

export type WebServiceKey = keyof typeof WEB_SERVICES;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export type RegistryEntry = DashboardEntry | WebServiceEntry;

export function getDashboard(key: DashboardKey): DashboardEntry {
    return DASHBOARDS[key];
}

export function listDashboards(): readonly DashboardEntry[] {
    return Object.values(DASHBOARDS);
}

export function getWebService(key: WebServiceKey): WebServiceEntry {
    return WEB_SERVICES[key];
}

export function listWebServices(): readonly WebServiceEntry[] {
    return Object.values(WEB_SERVICES);
}

/** Every registered port entry (dashboards + web services). */
export function listPortRegistry(): readonly RegistryEntry[] {
    return [...listDashboards(), ...listWebServices()];
}

const REGISTRY_BY_PORT: ReadonlyMap<number, RegistryEntry> = new Map(listPortRegistry().map((e) => [e.port, e]));

export function registryEntryForPort(port: number): RegistryEntry | null {
    return REGISTRY_BY_PORT.get(port) ?? null;
}

/**
 * If `port` is registered AND `matchProcess` accepts the live process, return the entry.
 * Port-only hits without process match return null (stolen port).
 */
export function matchRegistryProcess(ctx: PortMatchContext): RegistryEntry | null {
    const entry = registryEntryForPort(ctx.port);
    if (!entry) {
        return null;
    }

    if (!entry.matchProcess(ctx)) {
        return null;
    }

    return entry;
}

/** Human name when the live process matches a registry entry. */
export function registryNameForProcess(ctx: PortMatchContext): string | null {
    return matchRegistryProcess(ctx)?.name ?? null;
}

/** Human name for a registered port regardless of process match (hint only). */
export function registryNameForPort(port: number): string | null {
    return registryEntryForPort(port)?.name ?? null;
}

export function dashboardUrl(key: DashboardKey, host = "localhost"): string {
    const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

    return `http://${normalizedHost}:${DASHBOARDS[key].port}`;
}

/**
 * Groups of registry entries sharing a port. Empty array = no conflicts.
 * Covers DASHBOARDS + WEB_SERVICES.
 */
export function findPortConflicts(): ReadonlyArray<{ port: number; keys: string[] }> {
    const byPort = new Map<number, string[]>();

    for (const entry of listPortRegistry()) {
        const keys = byPort.get(entry.port) ?? [];
        keys.push(entry.key);
        byPort.set(entry.port, keys);
    }

    const conflicts: Array<{ port: number; keys: string[] }> = [];
    for (const [port, keys] of byPort) {
        if (keys.length > 1) {
            conflicts.push({ port, keys });
        }
    }

    return conflicts;
}
