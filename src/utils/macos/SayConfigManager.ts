import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage.ts";

export type SayProvider = "macos" | "xai" | "openai";

export interface SayAppConfig {
    name: string;
    voice?: string | null;
    volume?: number | null;
    provider?: SayProvider | null;
    rate?: number | null;
    model?: string | null;
    format?: "mp3" | "wav" | null;
    language?: string | null;
    mute?: boolean | null;
}

export interface SayConfigV2 {
    version: 2;
    global: { mute: boolean };
    apps: SayAppConfig[];
}

interface SayConfigV1 {
    defaultVoice?: string | null;
    defaultVolume?: number;
    globalMute?: boolean;
    appMute?: Record<string, boolean>;
    appVolume?: Record<string, number>;
}

export const DEFAULT_APP_NAME = "default";

/** Fields persistable per app via `--save` and the interactive config TUI. */
export const SETTABLE_FIELDS = [
    "voice",
    "volume",
    "provider",
    "rate",
    "model",
    "format",
    "language",
    "mute",
] as const satisfies readonly Exclude<keyof SayAppConfig, "name">[];

export type SettableField = (typeof SETTABLE_FIELDS)[number];

export function isSettableField(s: string): s is SettableField {
    return (SETTABLE_FIELDS as readonly string[]).includes(s);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
    const out: Partial<T> = {};

    for (const k of Object.keys(o) as (keyof T)[]) {
        const v = o[k];

        if (v !== undefined) {
            out[k] = v;
        }
    }

    return out;
}

function freshDefaultApp(): SayAppConfig {
    return normalizeAppShape({ name: DEFAULT_APP_NAME });
}

/**
 * Ensure every settable field exists on the saved app entry, using `null` when
 * unset. This keeps the on-disk JSON self-documenting (you can see all available
 * fields) and makes "fall through to default" explicit. Resolution treats null
 * and missing identically — both mean "inherit".
 */
function normalizeAppShape(app: SayAppConfig): SayAppConfig {
    const out: SayAppConfig = { name: app.name };

    for (const field of SETTABLE_FIELDS) {
        const v = app[field];
        out[field] = (v ?? null) as never;
    }

    return out;
}

function freshV2(): SayConfigV2 {
    return { version: 2, global: { mute: false }, apps: [freshDefaultApp()] };
}

function isV2(raw: unknown): raw is SayConfigV2 {
    if (typeof raw !== "object" || raw === null) {
        return false;
    }

    const v = (raw as { version?: unknown }).version;
    return v === 2;
}

function ensureDefaultApp(c: SayConfigV2): SayConfigV2 {
    if (!c.apps.some((a) => a.name === DEFAULT_APP_NAME)) {
        c.apps.unshift(freshDefaultApp());
    }

    return c;
}

function migrateV1(raw: SayConfigV1): SayConfigV2 {
    const v2 = freshV2();
    const def = v2.apps[0];

    if (raw.defaultVoice != null) {
        def.voice = raw.defaultVoice;
    }

    if (raw.defaultVolume != null) {
        def.volume = raw.defaultVolume;
    }

    if (raw.globalMute) {
        v2.global.mute = true;
    }

    const names = new Set<string>([...Object.keys(raw.appMute ?? {}), ...Object.keys(raw.appVolume ?? {})]);

    for (const name of names) {
        if (name === DEFAULT_APP_NAME) {
            continue;
        }

        const app: SayAppConfig = { name };

        if (raw.appMute?.[name]) {
            app.mute = true;
        }

        if (raw.appVolume?.[name] != null) {
            app.volume = raw.appVolume[name];
        }

        v2.apps.push(app);
    }

    return v2;
}

/**
 * Resolve effective config for an app by layering it over the default app.
 * Missing/null fields on the target app inherit from default; missing on
 * default mean "no preference" (caller / provider applies its own default).
 */
export function resolveOver(target: SayAppConfig, base: SayAppConfig): SayAppConfig {
    const merged: SayAppConfig = { name: target.name };

    for (const field of SETTABLE_FIELDS) {
        const fromTarget = target[field];

        if (fromTarget != null) {
            merged[field] = fromTarget as never;
            continue;
        }

        const fromBase = base[field];

        if (fromBase != null) {
            merged[field] = fromBase as never;
        }
    }

    return merged;
}

export class SayConfigManager {
    private cache: SayConfigV2 | null = null;
    private pendingV1Backup: string | null = null;

    constructor(private readonly storage = new Storage("say")) {}

    async load(): Promise<SayConfigV2> {
        if (this.cache) {
            return this.cache;
        }

        const raw = await this.storage.getConfig<Record<string, unknown>>();

        if (raw === null || raw === undefined) {
            this.cache = freshV2();
            return this.cache;
        }

        if (isV2(raw)) {
            this.cache = ensureDefaultApp(raw);
            return this.cache;
        }

        this.pendingV1Backup = SafeJSON.stringify(raw, null, 2);
        this.cache = migrateV1(raw as SayConfigV1);
        return this.cache;
    }

    async save(c: SayConfigV2): Promise<void> {
        if (this.pendingV1Backup) {
            const backupPath = join(dirname(this.storage.getConfigPath()), "config.v1.bak.json");

            if (!existsSync(backupPath)) {
                await Bun.write(backupPath, this.pendingV1Backup);
            }

            this.pendingV1Backup = null;
        }

        const out = ensureDefaultApp({ version: 2, global: c.global, apps: c.apps.map(normalizeAppShape) });
        await this.storage.setConfig(out);
        this.cache = out;
    }

    async getApp(name: string): Promise<SayAppConfig | undefined> {
        const c = await this.load();
        return c.apps.find((a) => a.name === name);
    }

    async getDefaultApp(): Promise<SayAppConfig> {
        const c = await this.load();
        const def = c.apps.find((a) => a.name === DEFAULT_APP_NAME);

        if (!def) {
            const fresh = freshDefaultApp();
            c.apps.unshift(fresh);
            return fresh;
        }

        return def;
    }

    async listApps(): Promise<SayAppConfig[]> {
        const c = await this.load();
        return c.apps;
    }

    async getGlobalMute(): Promise<boolean> {
        const c = await this.load();
        return c.global.mute;
    }

    /**
     * Return a merged config for the given app: app fields layered over the
     * default app's fields. If `name` is undefined, returns the default app.
     */
    async resolveApp(name?: string): Promise<SayAppConfig> {
        const def = await this.getDefaultApp();

        if (!name || name === DEFAULT_APP_NAME) {
            return { ...def };
        }

        const target = await this.getApp(name);

        if (!target) {
            return { ...def, name };
        }

        return resolveOver(target, def);
    }

    async upsertApp(app: SayAppConfig): Promise<void> {
        if (!app.name) {
            throw new Error("App name is required");
        }

        const c = await this.load();
        const idx = c.apps.findIndex((a) => a.name === app.name);

        if (idx === -1) {
            c.apps.push(app);
        } else {
            c.apps[idx] = app;
        }

        await this.save(c);
    }

    async patchApp(name: string, patch: Partial<Omit<SayAppConfig, "name">>): Promise<SayAppConfig> {
        const c = await this.load();
        let app = c.apps.find((a) => a.name === name);

        if (!app) {
            app = { name };
            c.apps.push(app);
        }

        Object.assign(app, stripUndefined(patch));

        await this.save(c);
        return app;
    }

    async unsetAppFields(name: string, fields: readonly SettableField[]): Promise<void> {
        if (fields.length === 0) {
            return;
        }

        const c = await this.load();
        const app = c.apps.find((a) => a.name === name);

        if (!app) {
            return;
        }

        for (const f of fields) {
            app[f] = null as never;
        }

        await this.save(c);
    }

    async deleteApp(name: string): Promise<void> {
        if (name === DEFAULT_APP_NAME) {
            throw new Error(`Cannot delete the "${DEFAULT_APP_NAME}" app — it is the inherit base for all other apps.`);
        }

        const c = await this.load();
        c.apps = c.apps.filter((a) => a.name !== name);
        await this.save(c);
    }

    async setGlobalMute(mute: boolean): Promise<void> {
        const c = await this.load();
        c.global.mute = mute;
        await this.save(c);
    }

    async setVoice(args: { app: string; voice: string | null }): Promise<void> {
        await this.patchApp(args.app, { voice: args.voice });
    }

    async setVolume(args: { app: string; volume: number | null }): Promise<void> {
        await this.patchApp(args.app, { volume: args.volume });
    }

    async setProvider(args: { app: string; provider: SayProvider | null }): Promise<void> {
        await this.patchApp(args.app, { provider: args.provider });
    }

    async setRate(args: { app: string; rate: number | null }): Promise<void> {
        await this.patchApp(args.app, { rate: args.rate });
    }

    async setModel(args: { app: string; model: string | null }): Promise<void> {
        await this.patchApp(args.app, { model: args.model });
    }

    async setFormat(args: { app: string; format: "mp3" | "wav" | null }): Promise<void> {
        await this.patchApp(args.app, { format: args.format });
    }

    async setLanguage(args: { app: string; language: string | null }): Promise<void> {
        await this.patchApp(args.app, { language: args.language });
    }

    async setMute(args: { app: string; mute: boolean }): Promise<void> {
        await this.patchApp(args.app, { mute: args.mute });
    }

    /** Whether a given app (or the implicit caller) is muted. */
    async isMuted(app?: string): Promise<boolean> {
        const c = await this.load();

        if (c.global.mute) {
            return true;
        }

        if (!app) {
            return false;
        }

        const a = c.apps.find((x) => x.name === app);
        return a?.mute === true;
    }
}
