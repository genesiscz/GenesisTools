import type { AnthropicModelCategory, ModelSelection } from "@ask/providers/ModelResolver";
import type { DetectedProvider, ModelInfo } from "@ask/types";
import type { AIProvider } from "./account-types";

/**
 * A handle to an AI account from AIConfigStorage.
 * Lazy-initialized — no I/O until `.provider()` is called.
 */
export class AIAccount {
    readonly name: string;
    readonly providerType: AIProvider;
    private _provider: DetectedProvider | null = null;

    private constructor(name: string, providerType: AIProvider) {
        this.name = name;
        this.providerType = providerType;
    }

    // ── Claude factories ──

    /** Choose a specific Claude subscription account by name. Synchronous — no I/O. */
    static chooseClaude(name: string): AIAccount {
        return new AIAccount(name, "anthropic-sub");
    }

    /** Use the default Claude subscription account. */
    static async defaultClaude(): Promise<AIAccount> {
        const { aiConfigStorage } = await import("./account-storage");
        const accounts = await aiConfigStorage.getAccountsByProvider("anthropic-sub");

        if (accounts.length === 0) {
            throw new Error("No Claude subscription accounts configured. Run `tools ask config` first.");
        }

        const config = await aiConfigStorage.load();
        const defaultName = config.defaultAccount;

        // Prefer the default if it's a Claude sub account
        if (defaultName) {
            const match = accounts.find((a) => a.name === defaultName);

            if (match) {
                return new AIAccount(match.name, "anthropic-sub");
            }
        }

        return new AIAccount(accounts[0].name, "anthropic-sub");
    }

    /** List all Claude subscription accounts. */
    static async listClaude(): Promise<AIAccount[]> {
        const { aiConfigStorage } = await import("./account-storage");
        const accounts = await aiConfigStorage.getAccountsByProvider("anthropic-sub");
        return accounts.map((a) => new AIAccount(a.name, "anthropic-sub"));
    }

    // ── Codex factories (stub) ──

    /** Choose a specific OpenAI/Codex account by name. Synchronous — no I/O. */
    static chooseCodex(name: string): AIAccount {
        return new AIAccount(name, "openai");
    }

    /** List all OpenAI/Codex accounts. */
    static async listCodex(): Promise<AIAccount[]> {
        const { aiConfigStorage } = await import("./account-storage");
        const apiAccounts = await aiConfigStorage.getAccountsByProvider("openai");
        const subAccounts = await aiConfigStorage.getAccountsByProvider("openai-sub");
        return [...apiAccounts, ...subAccounts].map((a) => new AIAccount(a.name, a.provider));
    }

    // ── Generic ──

    /** List all accounts across all providers. */
    static async list(): Promise<AIAccount[]> {
        const { aiConfigStorage } = await import("./account-storage");
        const accounts = await aiConfigStorage.listAccounts();
        return accounts.map((a) => new AIAccount(a.name, a.provider));
    }

    /** Look up an account by name. */
    static async fromConfig(name: string): Promise<AIAccount> {
        const { aiConfigStorage } = await import("./account-storage");
        const entry = await aiConfigStorage.getAccount(name);

        if (!entry) {
            throw new Error(`Account "${name}" not found. Run \`tools ask config\` to add it.`);
        }

        return new AIAccount(entry.name, entry.provider);
    }

    // ── Instance methods ──

    /**
     * Resolve the DetectedProvider for this account.
     * Dispatches on providerType. Cached per instance after first call.
     */
    async provider(): Promise<DetectedProvider> {
        if (this._provider) {
            return this._provider;
        }

        switch (this.providerType) {
            case "anthropic-sub":
                this._provider = await this.resolveAnthropicSubscription();
                break;
            case "anthropic":
                this._provider = await this.resolveAnthropicApiKey();
                break;
            case "openai":
            case "openai-sub":
                throw new Error(`OpenAI provider not yet implemented. Account: "${this.name}"`);
            default:
                throw new Error(`Unsupported provider type: "${this.providerType}" for account "${this.name}"`);
        }

        return this._provider;
    }

    /** Get available models for this account. */
    async models(): Promise<ModelInfo[]> {
        return (await this.provider()).models;
    }

    /** Resolve a model by category (e.g. "haiku") or exact ID. */
    async model(selection: AnthropicModelCategory | string): Promise<ModelSelection> {
        const { resolveModel } = await import("@ask/providers/ModelResolver");
        const models = await this.models();
        return resolveModel(selection, models);
    }

    /** Invalidate cached provider (force re-resolve on next access). */
    invalidate(): void {
        this._provider = null;
    }

    // ── Private resolvers ──

    private async resolveAnthropicSubscription(): Promise<DetectedProvider> {
        const { ProviderManager } = await import("@ask/providers/ProviderManager");
        const pm = new ProviderManager();
        const p = await pm.createSubscriptionProvider(this.name);

        if (!p) {
            throw new Error(`Account "${this.name}" not found or token resolution failed. Run \`tools ask config\`.`);
        }

        return p;
    }

    private async resolveAnthropicApiKey(): Promise<DetectedProvider> {
        const { aiConfigStorage } = await import("./account-storage");
        const entry = await aiConfigStorage.getAccount(this.name);

        if (!entry?.tokens.apiKey) {
            throw new Error(`No API key found for account "${this.name}".`);
        }

        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const provider = createAnthropic({ apiKey: entry.tokens.apiKey });

        const { getProviderConfigs, KNOWN_MODELS } = await import("@ask/providers/providers");
        const anthropicConfig = getProviderConfigs().find((c) => c.name === "anthropic");

        if (!anthropicConfig) {
            throw new Error("anthropic provider config missing from PROVIDER_CONFIGS");
        }

        // Use known models — same set available via API key or subscription
        const { dynamicPricingManager } = await import("@ask/providers/DynamicPricing");
        const models: ModelInfo[] = await Promise.all(
            KNOWN_MODELS.anthropic.map(async (m) => ({
                ...m,
                provider: "anthropic",
                pricing: (await dynamicPricingManager.getPricing("anthropic", m.id)) || undefined,
            }))
        );

        return {
            name: "anthropic",
            type: "anthropic",
            key: `${entry.tokens.apiKey.slice(0, 12)}...`,
            provider,
            models,
            config: anthropicConfig,
        };
    }
}
