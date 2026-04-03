import type { DetectedProvider, ModelInfo } from "@ask/types";
import type { AnthropicModelCategory, ModelSelection } from "@ask/providers/ModelResolver";

/**
 * A handle to a Claude subscription account from `tools claude config`.
 * Lazy-initialized — no I/O until `.provider()` is called.
 */
export class ClaudeAccount {
	readonly name: string;
	private _provider: DetectedProvider | null = null;

	private constructor(name: string) {
		this.name = name;
	}

	/**
	 * Choose a specific account by name.
	 * Synchronous — no I/O. Provider is resolved lazily on first use.
	 */
	static choose(name: string): ClaudeAccount {
		return new ClaudeAccount(name);
	}

	/**
	 * Use the default account from `tools claude config`.
	 */
	static async default(): Promise<ClaudeAccount> {
		const { loadConfig } = await import("@app/claude/lib/config");
		const config = await loadConfig();

		if (!config.defaultAccount) {
			throw new Error("No default account set. Run `tools claude login`.");
		}

		return new ClaudeAccount(config.defaultAccount);
	}

	/**
	 * List all accounts from `tools claude config`.
	 */
	static async list(): Promise<ClaudeAccount[]> {
		const { loadConfig } = await import("@app/claude/lib/config");
		const config = await loadConfig();
		return Object.keys(config.accounts).map((name) => ClaudeAccount.choose(name));
	}

	/**
	 * Resolve the DetectedProvider for this account.
	 * Auto-refreshes OAuth tokens under file lock.
	 * Cached per instance after first call.
	 */
	async provider(): Promise<DetectedProvider> {
		if (this._provider) {
			return this._provider;
		}

		const { ProviderManager } = await import("@ask/providers/ProviderManager");
		const pm = new ProviderManager();
		const p = await pm.createSubscriptionProvider(this.name);

		if (!p) {
			throw new Error(
				`Account "${this.name}" not found or token resolution failed. Run \`tools claude login\`.`,
			);
		}

		this._provider = p;
		return this._provider;
	}

	/**
	 * Get available models for this account.
	 */
	async models(): Promise<ModelInfo[]> {
		return (await this.provider()).models;
	}

	/**
	 * Resolve a model by category (e.g. AnthropicModelCategory.Haiku) or exact ID.
	 */
	async model(selection: AnthropicModelCategory | string): Promise<ModelSelection> {
		const { resolveModel } = await import("@ask/providers/ModelResolver");
		const models = await this.models();
		return resolveModel(selection, models);
	}

	/** Invalidate cached provider (force re-resolve on next access). */
	invalidate(): void {
		this._provider = null;
	}
}
