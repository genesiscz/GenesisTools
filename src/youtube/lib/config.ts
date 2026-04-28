import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { withFileLock } from "@app/utils/storage";
import type { YoutubeConfigInit, YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import type { YoutubeConfigShape } from "@app/youtube/lib/config.types";

export const DEFAULT_BASE_DIR = join(homedir(), ".genesis-tools", "youtube");
export const CONFIG_FILENAME = "server.json";

export const DEFAULT_YOUTUBE_CONFIG: YoutubeConfigShape = {
    apiPort: 9876,
    apiBaseUrl: "http://localhost:9876",
    provider: {},
    defaultQuality: "720p",
    concurrency: {
        download: 4,
        localTranscribe: 2,
        cloudTranscribe: 8,
        summarize: 4,
    },
    ttls: {
        audio: "7 days",
        video: "3 days",
        thumb: "30 days",
        channelListing: "24 hours",
    },
    keepVideo: false,
    firstRunComplete: false,
    lastPruneAt: null,
    preferredLangs: ["en"],
};

export class YoutubeConfig {
    private readonly baseDir: string;
    private readonly path: string;
    private cache: YoutubeConfigShape | null = null;

    constructor(init: YoutubeConfigInit = {}) {
        this.baseDir = init.baseDir ?? DEFAULT_BASE_DIR;
        this.path = join(this.baseDir, CONFIG_FILENAME);
    }

    where(): string {
        return this.path;
    }

    async getAll(): Promise<YoutubeConfigShape> {
        if (this.cache) {
            return structuredClone(this.cache);
        }

        if (!existsSync(this.path)) {
            this.cache = structuredClone(DEFAULT_YOUTUBE_CONFIG);
            return structuredClone(this.cache);
        }

        const raw = await Bun.file(this.path).text();
        const parsed = SafeJSON.parse(raw, { unbox: true }) as YoutubeConfigPatch | undefined;
        this.cache = mergeConfig(DEFAULT_YOUTUBE_CONFIG, parsed ?? {});

        return structuredClone(this.cache);
    }

    async get<K extends keyof YoutubeConfigShape>(key: K): Promise<YoutubeConfigShape[K]> {
        const all = await this.getAll();

        return all[key];
    }

    async set<K extends keyof YoutubeConfigShape>(key: K, value: YoutubeConfigShape[K]): Promise<void> {
        await this.update({ [key]: value } as YoutubeConfigPatch);
    }

    async update(partial: YoutubeConfigPatch): Promise<void> {
        await this.ensureDir();
        await withFileLock(`${this.path}.lock`, async () => {
            const current = await this.readFresh();
            const merged = mergeConfig(current, partial);
            await Bun.write(this.path, `${SafeJSON.stringify(merged, { strict: true }, 2)}\n`);
            this.cache = merged;
            logger.debug({ path: this.path }, "youtube config updated");
        });
    }

    async reset(): Promise<void> {
        await this.ensureDir();
        await withFileLock(`${this.path}.lock`, async () => {
            const defaults = structuredClone(DEFAULT_YOUTUBE_CONFIG);
            await Bun.write(this.path, `${SafeJSON.stringify(defaults, { strict: true }, 2)}\n`);
            this.cache = defaults;
            logger.debug({ path: this.path }, "youtube config reset");
        });
    }

    private async readFresh(): Promise<YoutubeConfigShape> {
        if (!existsSync(this.path)) {
            return structuredClone(DEFAULT_YOUTUBE_CONFIG);
        }

        const raw = await Bun.file(this.path).text();
        const parsed = SafeJSON.parse(raw, { unbox: true }) as YoutubeConfigPatch | undefined;

        return mergeConfig(DEFAULT_YOUTUBE_CONFIG, parsed ?? {});
    }

    private async ensureDir(): Promise<void> {
        if (!existsSync(this.baseDir)) {
            mkdirSync(this.baseDir, { recursive: true });
        }

        const configDir = dirname(this.path);

        if (!existsSync(configDir)) {
            mkdirSync(configDir, { recursive: true });
        }
    }
}

function mergeConfig(base: YoutubeConfigShape, patch: YoutubeConfigPatch): YoutubeConfigShape {
    return {
        ...base,
        ...patch,
        provider: { ...base.provider, ...patch.provider },
        concurrency: { ...base.concurrency, ...patch.concurrency },
        ttls: { ...base.ttls, ...patch.ttls },
        preferredLangs: patch.preferredLangs ?? base.preferredLangs,
    };
}
