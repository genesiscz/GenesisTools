import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type {
    DefaultLandingView,
    NotificationChannelsConfig,
    SettingsPayload,
    ShopConfig,
    ThemeChoice,
} from "@app/shops/types";

const log = logger.child({ component: "SettingsRepository" });

const DEFAULTS: SettingsPayload = {
    default_landing_view: "/watchlist",
    theme: "cyberpunk",
    notification_channels: {
        macos: true,
        web_sse: true,
        telegram: false,
        telegram_bot_token: null,
        telegram_chat_id: null,
    },
    default_cooldown_hours: 24,
    http_requests_retention_days: 30,
    default_rate_limit_per_second: 2,
    shops: {},
    daemon_enabled: false,
};

const ALLOWED_LANDINGS: readonly DefaultLandingView[] = ["/watchlist", "/", "/browse", "/live", "/workspace"];
const ALLOWED_THEMES: readonly ThemeChoice[] = ["cyberpunk", "wow"];

export type SettingsPatch = {
    default_landing_view?: DefaultLandingView;
    theme?: ThemeChoice;
    notification_channels?: Partial<NotificationChannelsConfig>;
    default_cooldown_hours?: number;
    http_requests_retention_days?: number;
    default_rate_limit_per_second?: number;
    shops?: Record<string, ShopConfig>;
    daemon_enabled?: boolean;
};

export class SettingsRepository {
    private writeChain: Promise<void> = Promise.resolve();

    constructor(private readonly path: string) {}

    async read(): Promise<SettingsPayload> {
        try {
            const raw = await readFile(this.path, "utf8");
            const parsed = SafeJSON.parse(raw) as Partial<SettingsPayload>;
            return mergeWithDefaults(parsed);
        } catch (err) {
            if (isFileNotFound(err)) {
                return {
                    ...DEFAULTS,
                    notification_channels: { ...DEFAULTS.notification_channels },
                    shops: { ...DEFAULTS.shops },
                };
            }

            log.warn({ err, path: this.path }, "settings: failed to read; falling back to defaults");
            return {
                ...DEFAULTS,
                notification_channels: { ...DEFAULTS.notification_channels },
                shops: { ...DEFAULTS.shops },
            };
        }
    }

    async patch(patch: SettingsPatch): Promise<SettingsPayload> {
        validatePatch(patch);
        const result = this.writeChain.then(() => this.applyPatch(patch));
        this.writeChain = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    private async applyPatch(patch: SettingsPatch): Promise<SettingsPayload> {
        const current = await this.read();
        const next: SettingsPayload = {
            ...current,
            ...patch,
            notification_channels: patch.notification_channels
                ? { ...current.notification_channels, ...patch.notification_channels }
                : current.notification_channels,
            shops: patch.shops ? { ...current.shops, ...patch.shops } : current.shops,
        };
        await ensureDir(this.path);
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, SafeJSON.stringify(next, null, 2), "utf8");
        await Bun.write(this.path, await Bun.file(tmp).bytes());
        log.info(
            {
                changed: Object.keys(patch),
                redacted: this.toLogString(next),
            },
            "settings: persisted patch"
        );
        return next;
    }

    toLogString(settings: SettingsPayload): string {
        const redacted: SettingsPayload = {
            ...settings,
            notification_channels: {
                ...settings.notification_channels,
                telegram_bot_token: settings.notification_channels.telegram_bot_token ? "REDACTED" : null,
            },
        };
        return SafeJSON.stringify(redacted);
    }
}

function mergeWithDefaults(parsed: Partial<SettingsPayload>): SettingsPayload {
    return {
        ...DEFAULTS,
        ...parsed,
        notification_channels: { ...DEFAULTS.notification_channels, ...(parsed.notification_channels ?? {}) },
        shops: { ...DEFAULTS.shops, ...(parsed.shops ?? {}) },
    };
}

function validatePatch(patch: SettingsPatch): void {
    if (patch.default_landing_view !== undefined && !ALLOWED_LANDINGS.includes(patch.default_landing_view)) {
        throw new Error(
            `default_landing_view must be one of ${ALLOWED_LANDINGS.join(", ")}; got ${patch.default_landing_view}`
        );
    }

    if (patch.theme !== undefined && !ALLOWED_THEMES.includes(patch.theme)) {
        throw new Error(`theme must be one of ${ALLOWED_THEMES.join(", ")}; got ${patch.theme}`);
    }

    if (patch.default_cooldown_hours !== undefined) {
        if (!Number.isFinite(patch.default_cooldown_hours) || patch.default_cooldown_hours < 0) {
            throw new Error(`default_cooldown_hours must be ≥ 0; got ${patch.default_cooldown_hours}`);
        }
    }

    if (patch.http_requests_retention_days !== undefined) {
        if (!Number.isFinite(patch.http_requests_retention_days) || patch.http_requests_retention_days < 1) {
            throw new Error(`http_requests_retention_days must be ≥ 1; got ${patch.http_requests_retention_days}`);
        }
    }

    if (patch.default_rate_limit_per_second !== undefined) {
        if (!Number.isFinite(patch.default_rate_limit_per_second) || patch.default_rate_limit_per_second <= 0) {
            throw new Error(`default_rate_limit_per_second must be > 0; got ${patch.default_rate_limit_per_second}`);
        }
    }

    if (patch.shops) {
        for (const [origin, cfg] of Object.entries(patch.shops)) {
            if (
                cfg.rate_limit_per_second !== null &&
                (!Number.isFinite(cfg.rate_limit_per_second) || cfg.rate_limit_per_second <= 0)
            ) {
                throw new Error(
                    `shops['${origin}'].rate_limit_per_second must be > 0 or null; got ${cfg.rate_limit_per_second}`
                );
            }
        }
    }
}

async function ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
}

function isFileNotFound(err: unknown): boolean {
    return err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT";
}

let _singleton: SettingsRepository | null = null;

export function getSettingsRepository(): SettingsRepository {
    if (!_singleton) {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
        _singleton = new SettingsRepository(`${home}/.genesis-tools/shops/config.json`);
    }

    return _singleton;
}

export function setSettingsRepositoryForTest(repo: SettingsRepository | null): void {
    _singleton = repo;
}
