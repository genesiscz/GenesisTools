import { chmod } from "node:fs/promises";
import {
    createBasicAuthCredentials,
    type DashboardAuthConfig,
    isCompleteAuthConfig,
} from "@app/dev-dashboard/lib/auth";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { Storage } from "@app/utils/storage/storage";
import { z } from "zod";

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
    obsidianVault: z.string().default("/Users/Martin/Tresors/Projects/GenesisBrain"),
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

const storage = new Storage("dev-dashboard");

export async function getConfig(): Promise<DevDashboardConfig> {
    const raw = await storage.getConfig<Partial<DevDashboardConfig>>();
    const parsed = DevDashboardConfigSchema.safeParse(raw ?? {});

    if (parsed.success) {
        return parsed.data;
    }

    return DevDashboardConfigSchema.parse({});
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

export async function saveTtydSessions(ttydSessions: TtydSession[]): Promise<void> {
    const config = await getConfig();
    await saveConfig({ ...config, ttydSessions });
}

export { storage };
