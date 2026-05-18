import { chmod } from "node:fs/promises";
import {
    createBasicAuthCredentials,
    type DashboardAuthConfig,
    isCompleteAuthConfig,
} from "@app/dev-dashboard/lib/auth";
import { getDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import logger from "@app/logger";
import { resolveVaultRoot } from "@app/utils/obsidian/config";
import { z } from "zod";

/**
 * Resolve the Obsidian vault for the dashboard. An explicit per-dashboard
 * config value still wins (override); otherwise defer to the shared
 * src/utils/obsidian resolver (unified config → obsidian.json discovery).
 * No hardcoded user path.
 */
export function resolveDashboardVault(explicit?: string | null): string | null {
    return explicit ?? resolveVaultRoot();
}

const DashboardAuthSchema = z.object({
    enabled: z.boolean().default(true),
    username: z.string().min(1).default("martin"),
    passwordSalt: z.string().min(1).optional(),
    passwordHash: z.string().min(1).optional(),
});

const PublishedNoteSchema = z.object({
    slug: z.string(),
    vaultPath: z.string(),
    publishedAt: z.string(),
});

const TtydSessionSchema = z.object({
    id: z.string(),
    port: z.number().int().min(1).max(65535),
    command: z.string(),
    cwd: z.string(),
    pid: z.number().int(),
    startedAt: z.string(),
    tmuxSessionName: z.string().optional(),
});

const WeatherCoordsSchema = z.object({
    latitude: z.number().default(50.0755),
    longitude: z.number().default(14.4378),
    label: z.string().default("Prague"),
});

const PulseConfigSchema = z.object({
    retentionHours: z.number().int().min(1).default(24),
    pollIntervalMs: z.number().int().min(1000).default(5000),
});

const DevDashboardConfigSchema = z.object({
    port: z.number().int().min(1).max(65535).default(3042),
    obsidianVault: z.string().optional(),
    publishedNotes: z.array(PublishedNoteSchema).default([]),
    cmuxPollIntervalMs: z.number().int().min(250).default(2000),
    auth: DashboardAuthSchema.default({}),
    ttydSessions: z.array(TtydSessionSchema).default([]),
    weatherCoords: WeatherCoordsSchema.default({}),
    pulse: PulseConfigSchema.default({}),
    todoListName: z.string().default("GenesisTools"),
});

export type PublishedNote = z.infer<typeof PublishedNoteSchema>;
export type WeatherCoords = z.infer<typeof WeatherCoordsSchema>;
export type PulseConfig = z.infer<typeof PulseConfigSchema>;
export type DevDashboardConfig = z.infer<typeof DevDashboardConfigSchema>;
export interface DashboardAuthProvision {
    auth: DashboardAuthConfig;
    generatedPassword: string | null;
}

const storage = getDevDashboardStorage();

export async function getConfig(): Promise<DevDashboardConfig> {
    const raw = await storage.getConfig<Partial<DevDashboardConfig>>();
    const parsed = DevDashboardConfigSchema.safeParse(raw ?? {});

    if (parsed.success) {
        return { ...parsed.data, obsidianVault: resolveDashboardVault(parsed.data.obsidianVault) ?? "" };
    }

    logger.warn(
        { issues: parsed.error.issues },
        "dev-dashboard config failed schema validation; falling back to defaults"
    );

    const fallback = DevDashboardConfigSchema.parse({});
    return { ...fallback, obsidianVault: resolveDashboardVault(fallback.obsidianVault) ?? "" };
}

export async function saveConfig(config: DevDashboardConfig): Promise<void> {
    DevDashboardConfigSchema.parse(config);
    await storage.ensureDirs();
    await storage.setConfig(config);

    if (process.platform !== "win32") {
        await chmod(storage.getConfigPath(), 0o600);
    }
}

export async function getOrCreateDashboardAuth(): Promise<DashboardAuthProvision> {
    const config = await getConfig();

    if (!config.auth.enabled || isCompleteAuthConfig(config.auth)) {
        return { auth: config.auth, generatedPassword: null };
    }

    const { auth, password } = createBasicAuthCredentials({ username: config.auth.username });
    await saveConfig({ ...config, auth });

    return { auth, generatedPassword: password };
}

// Both the Vite middleware (cookie issuer) and the front-proxy (cookie/Basic
// verifier for ttyd + WS) resolve auth through this one 30s-TTL cache. A single
// source of truth means a mid-session `auth reset` propagates to issuer AND
// verifier together within the TTL — no permanent tunnel-ttyd breakage, no
// restart needed — while collapsing what was a per-request config-file read.
const AUTH_CACHE_TTL_MS = 30_000;
let authCache: { provision: DashboardAuthProvision; at: number } | null = null;
let authCacheInFlight: Promise<DashboardAuthProvision> | null = null;

export async function getDashboardAuthCached(): Promise<DashboardAuthProvision> {
    const now = Date.now();

    if (authCache && now - authCache.at < AUTH_CACHE_TTL_MS) {
        return authCache.provision;
    }

    // Coalesce concurrent cold/expired missers onto one provisioning call.
    // Without this, a first-run incomplete config makes each concurrent caller
    // generate and persist a *different* random password (last write wins) —
    // some requests would then be issued/verified against credentials a later
    // write silently replaced. Clear the in-flight ref on rejection so a
    // failed provision can be retried.
    if (authCacheInFlight) {
        return authCacheInFlight;
    }

    authCacheInFlight = getOrCreateDashboardAuth()
        .then((provision) => {
            authCache = { provision, at: Date.now() };
            return provision;
        })
        .finally(() => {
            authCacheInFlight = null;
        });

    return authCacheInFlight;
}

export async function saveTtydSessions(ttydSessions: TtydSession[]): Promise<void> {
    const config = await getConfig();
    await saveConfig({ ...config, ttydSessions });
}

export { storage };
