import { Storage } from "@app/utils/storage/storage";
import type { AIProviderType, AITask, TaskConfig } from "./types";

interface AIConfigData {
    hfToken?: string;
    transcribe: TaskConfig;
    translate: TaskConfig;
    summarize: TaskConfig;
    classify: TaskConfig;
    embed: TaskConfig;
    sentiment: TaskConfig;
}

const DEFAULT_CONFIG: AIConfigData = {
    transcribe: { provider: "local-hf", model: "whisper-small" },
    translate: { provider: "local-hf" },
    summarize: { provider: "cloud" },
    classify: { provider: "darwinkit" },
    embed: { provider: "darwinkit" },
    sentiment: { provider: "darwinkit" },
};

export class AIConfig {
    private storage: Storage;
    private data: AIConfigData;

    private constructor(storage: Storage, data: AIConfigData) {
        this.storage = storage;
        this.data = data;
    }

    static async load(): Promise<AIConfig> {
        const storage = new Storage("ai");
        const existing = await storage.getConfig<AIConfigData>();
        const data = existing ?? { ...DEFAULT_CONFIG };
        return new AIConfig(storage, data);
    }

    get(task: AITask): TaskConfig {
        return this.data[task] ?? DEFAULT_CONFIG[task];
    }

    set(task: AITask, config: Partial<TaskConfig>): void {
        const current = this.get(task);
        this.data[task] = { ...current, ...config };
    }

    getProvider(task: AITask): AIProviderType {
        return this.get(task).provider;
    }

    getHfToken(): string | undefined {
        return this.data.hfToken;
    }

    setHfToken(token: string): void {
        this.data.hfToken = token;
    }

    async save(): Promise<void> {
        await this.storage.setConfig(this.data);
    }
}
