import { readFileSync } from "node:fs";
import {
    createBasicAuthCredentials,
    type DashboardAuthConfig,
    isCompleteAuthConfig,
} from "@app/dev-dashboard/lib/auth";
import { getDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { resolveVaultRoot } from "@genesiscz/utils/obsidian/config";
import { REMOTE_DIR_RE, SSH_HOST_RE, TARGET_NAME_RE } from "@genesiscz/utils/publish/targets";
import { isSecureRef, type SecureRef } from "@genesiscz/utils/security/SecureRef";
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
    /** Read as NFC, so an entry stored decomposed by an older build matches a typed path (normalizeVaultPath). */
    vaultPath: z.string().transform((path) => path.normalize("NFC")),
    publishedAt: z.string(),
    /** A removed live target stays private while remote removals remain retryable. */
    live: z.boolean().optional(),
    /** Legacy fields read only for import into the publication ledger. */
    targets: z.array(z.string()).optional(),
    syncs: z.record(z.string(), z.object({ syncedAt: z.string(), sourceModifiedAt: z.string() })).optional(),
});

const TtydSessionSchema = z.object({
    id: z.string(),
    port: z.number().int().min(1).max(65535),
    command: z.string(),
    cwd: z.string(),
    pid: z.number().int(),
    startedAt: z.string(),
    tmuxSessionName: z.string().optional(),
    /** User-set display name; also mirrors the tmux session name after a unified rename. */
    name: z.string().optional(),
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

// The old dashboard file is only a migration source for publishing settings.
const LegacyTargetBase = z.object({
    name: z.string().regex(TARGET_NAME_RE),
    publicBase: z.string().url().optional(),
});
const LegacyTargets = z.discriminatedUnion("driver", [
    LegacyTargetBase.extend({ driver: z.literal("mac-live") }),
    LegacyTargetBase.extend({
        driver: z.literal("paired"),
        url: z.string().url(),
        deviceId: z.string().min(1),
        token: z.custom<SecureRef>(isSecureRef, { message: "token must be a vault reference" }),
    }),
    LegacyTargetBase.extend({
        driver: z.literal("ssh-rsync"),
        host: z.string().regex(SSH_HOST_RE),
        dataDir: z.string().regex(REMOTE_DIR_RE),
        publicBase: z.string().url(),
    }),
]);
const LEGACY_MAC = { name: "mac", driver: "mac-live" } as const;
const LegacyNamedShare = z.object({
    defaults: z.object({ target: z.string().default("mac") }).prefault({}),
    targets: z
        .array(LegacyTargets)
        .default([LEGACY_MAC])
        .superRefine((targets, ctx) => {
            const names = new Set<string>();
            for (const [index, target] of targets.entries()) {
                if (names.has(target.name)) {
                    ctx.addIssue({
                        code: "custom",
                        path: [index, "name"],
                        message: `Duplicate target "${target.name}"`,
                    });
                }

                names.add(target.name);
            }
        }),
});
const LegacySingleShare = z.object({
    target: z.enum(["server", "mac"]),
    server: z
        .object({ host: z.string().optional(), dataDir: z.string().optional(), publicBase: z.string().optional() })
        .optional(),
});
const LegacyShare = z.preprocess((raw) => {
    if (raw == null) {
        return undefined;
    }

    const single = LegacySingleShare.safeParse(raw);
    if (!single.success || (typeof raw === "object" && "targets" in raw)) {
        return raw;
    }

    const { host, dataDir, publicBase } = single.data.server ?? {};
    const server =
        host && dataDir && publicBase ? { name: "server", driver: "ssh-rsync", host, dataDir, publicBase } : null;
    return {
        defaults: { target: server && single.data.target === "server" ? "server" : "mac" },
        targets: server ? [LEGACY_MAC, server] : [LEGACY_MAC],
    };
}, LegacyNamedShare.optional());

export const LegacyShareSourceSchema = z.object({
    publishedNotes: z.array(PublishedNoteSchema).default([]),
    share: LegacyShare,
});

const DevDashboardConfigSchema = z.object({
    publishedNotes: z.array(PublishedNoteSchema).default([]),
    // Preserve deprecated data intact so a migration error cannot invalidate unrelated settings.
    share: z.unknown().optional(),
    port: z.number().int().min(1).max(65535).default(3042),
    allowedHosts: z.array(z.string()).default([]),
    obsidianVault: z.string().optional(),
    cmuxPollIntervalMs: z.number().int().min(250).default(2000),
    auth: DashboardAuthSchema.prefault({}),
    ttydSessions: z.array(TtydSessionSchema).default([]),
    weatherCoords: WeatherCoordsSchema.prefault({}),
    pulse: PulseConfigSchema.prefault({}),
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

export async function getConfig(): Promise<DevDashboardConfig> {
    // Resolved per call (not captured at module load) so resetDevDashboardStorage()
    // + GENESIS_TOOLS_HOME overrides in tests are honored.
    const raw = await getDevDashboardStorage().getConfig<Partial<DevDashboardConfig>>();
    const parsed = DevDashboardConfigSchema.safeParse(raw ?? {});

    if (parsed.success) {
        return { ...parsed.data, obsidianVault: resolveDashboardVault(parsed.data.obsidianVault) ?? "" };
    }

    logger.warn(
        { issues: parsed.error.issues, path: getDevDashboardStorage().getConfigPath() },
        "dev-dashboard config failed schema validation; serving defaults, and every save is refused until it is fixed"
    );

    const fallback = DevDashboardConfigSchema.parse({});
    return { ...fallback, obsidianVault: resolveDashboardVault(fallback.obsidianVault) ?? "" };
}

/** Serialize changes to the share settings and note registry across CLI and dashboard processes. */
export function withConfigMutation<T>(change: () => Promise<T>): Promise<T> {
    return getDevDashboardStorage().withConfigLock(change);
}

/**
 * Every write of the config goes through here, and it refuses to replace a file that exists but does
 * not parse or fails the schema. getConfig serves defaults for such a file, so each caller (auth
 * provisioning, ttyd sessions, publishedNotes, allowedHosts) would otherwise save those defaults plus
 * its one change over the user's auth hash and published notes.
 */
export async function saveConfig(config: DevDashboardConfig): Promise<void> {
    DevDashboardConfigSchema.parse(config);
    const storage = getDevDashboardStorage();
    assertExistingConfigReplaceable(storage.getConfigPath());
    // Atomic, and 0600 from the temp file's birth: the file holds the dashboard's password hash.
    await storage.setConfig(config, { mode: process.platform === "win32" ? undefined : 0o600 });
}

function assertExistingConfigReplaceable(path: string): void {
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return;
        }

        throw err;
    }

    let raw: unknown;

    try {
        raw = SafeJSON.parse(text);
    } catch (err) {
        logger.error({ err, path }, "dev-dashboard config does not parse; refusing to save over it");
        throw new Error(`dev-dashboard config ${path} does not parse, so it was left untouched. Fix or move it.`, {
            cause: err,
        });
    }

    const parsed = DevDashboardConfigSchema.safeParse(raw);

    if (!parsed.success) {
        logger.error(
            { issues: parsed.error.issues, path },
            "dev-dashboard config fails schema validation; refusing to save over it"
        );
        throw new Error(
            `dev-dashboard config ${path} fails schema validation, so it was left untouched. Fix or move it.`
        );
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
