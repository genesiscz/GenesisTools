import type { AIProvider } from "@app/utils/config/ai.types";
import type { AnthropicModelCategory, ModelSelection, OpenAIModelCategory } from "@ask/providers/ModelResolver";
import type { DetectedProvider, ModelInfo } from "@ask/types";

/**
 * A handle to an AI account from AIConfig.
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
        const { AIConfig } = await import("./AIConfig");
        const config = await AIConfig.load();

        // Try per-context default for "ask" (most common caller)
        const defaultEntry = config.getDefaultAccount("ask");

        if (defaultEntry?.provider === "anthropic-sub") {
            return new AIAccount(defaultEntry.name, "anthropic-sub");
        }

        // Fall back to first anthropic-sub account
        const accounts = config.getAccountsByProvider("anthropic-sub");

        if (accounts.length === 0) {
            throw new Error("No Claude subscription accounts configured. Run `tools ask config` first.");
        }

        return new AIAccount(accounts[0].name, "anthropic-sub");
    }

    /** List all Claude subscription accounts. */
    static async listClaude(): Promise<AIAccount[]> {
        const { AIConfig } = await import("./AIConfig");
        const config = await AIConfig.load();
        const accounts = config.getAccountsByProvider("anthropic-sub");
        return accounts.map((a) => new AIAccount(a.name, "anthropic-sub"));
    }

    // ── Codex factories (stub) ──

    /** Choose a specific OpenAI/Codex account by name. Synchronous — no I/O. */
    static chooseCodex(name: string, providerType: AIProvider = "openai-sub"): AIAccount {
        return new AIAccount(name, providerType);
    }

    /** Use the default OpenAI/Codex account. */
    static async defaultCodex(): Promise<AIAccount> {
        const { AIConfig } = await import("./AIConfig");
        const config = await AIConfig.load();

        const defaultEntry = config.getDefaultAccount("ask");

        if (defaultEntry?.provider === "openai-sub") {
            return new AIAccount(defaultEntry.name, "openai-sub");
        }

        // Fall back to first openai-sub account, then first openai account
        const subAccounts = config.getAccountsByProvider("openai-sub");

        if (subAccounts.length > 0) {
            return new AIAccount(subAccounts[0].name, "openai-sub");
        }

        const apiAccounts = config.getAccountsByProvider("openai");

        if (apiAccounts.length > 0) {
            return new AIAccount(apiAccounts[0].name, "openai");
        }

        throw new Error("No OpenAI accounts configured. Run `tools ask config` first.");
    }

    /** List all OpenAI/Codex accounts. */
    static async listCodex(): Promise<AIAccount[]> {
        const { AIConfig } = await import("./AIConfig");
        const config = await AIConfig.load();
        const apiAccounts = config.getAccountsByProvider("openai");
        const subAccounts = config.getAccountsByProvider("openai-sub");
        return [...apiAccounts, ...subAccounts].map((a) => new AIAccount(a.name, a.provider));
    }

    // ── Generic ──

    /** List all accounts across all providers. */
    static async list(): Promise<AIAccount[]> {
        const { AIConfig } = await import("./AIConfig");
        const config = await AIConfig.load();
        const accounts = config.listAccounts();
        return accounts.map((a) => new AIAccount(a.name, a.provider));
    }

    /** Look up an account by name. */
    static async fromConfig(name: string): Promise<AIAccount> {
        const { AIConfig } = await import("./AIConfig");
        const config = await AIConfig.load();
        const entry = config.getAccount(name);

        if (!entry) {
            throw new Error(`Account "${name}" not found. Run \`tools ask config\` to add it.`);
        }

        return new AIAccount(entry.name, entry.provider);
    }

    // ── Instance methods ──

    /**
     * Resolve the DetectedProvider for this account.
     * Delegates to the resolver registry. Cached per instance after first call.
     */
    async provider(): Promise<DetectedProvider> {
        if (this._provider) {
            return this._provider;
        }

        const { ensureResolversInitialized, getResolver } = await import("./resolvers");
        await ensureResolversInitialized();

        const resolver = getResolver(this.providerType);
        this._provider = await resolver.resolve(this.name);
        return this._provider;
    }

    /** Get available models for this account. */
    async models(): Promise<ModelInfo[]> {
        return (await this.provider()).models;
    }

    /** Resolve a model by category (e.g. "haiku") or exact ID. */
    async model(selection: AnthropicModelCategory | OpenAIModelCategory | string): Promise<ModelSelection> {
        const { resolveModel } = await import("@ask/providers/ModelResolver");
        const models = await this.models();
        return resolveModel(selection, models);
    }

    /** Invalidate cached provider (force re-resolve on next access). */
    invalidate(): void {
        this._provider = null;
    }
}
