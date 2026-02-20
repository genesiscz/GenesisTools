import { chmodSync } from "node:fs";
import { Storage } from "@app/utils/storage/storage";
import type { ContactConfig, TelegramConfigData } from "./types";
import { DEFAULTS } from "./types";

export class TelegramToolConfig {
    private storage = new Storage("telegram");
    private data: TelegramConfigData | null = null;

    async load(): Promise<TelegramConfigData | null> {
        this.data = await this.storage.getConfig<TelegramConfigData>();
        return this.data;
    }

    async save(config: TelegramConfigData): Promise<void> {
        await this.storage.setConfig(config);
        this.data = config;
        this.protect();
    }

    async updateSession(session: string): Promise<void> {
        await this.storage.setConfigValue("session", session);

        if (this.data) {
            this.data.session = session;
        }

        this.protect();
    }

    getApiId(): number {
        return this.data?.apiId ?? DEFAULTS.apiId;
    }

    getApiHash(): string {
        return this.data?.apiHash ?? DEFAULTS.apiHash;
    }

    getSession(): string {
        return this.data?.session ?? "";
    }

    getContacts(): ContactConfig[] {
        return this.data?.contacts ?? [];
    }

    hasValidSession(): boolean {
        return !!this.data?.session;
    }

    private protect(): void {
        try {
            chmodSync(this.storage.getConfigPath(), 0o600);
        } catch {
            // ignore — file may not exist yet
        }
    }
}
