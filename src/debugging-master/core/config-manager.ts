import { Storage } from "@app/utils/storage/storage";
import type { DebugMasterConfig, ProjectConfig } from "@app/debugging-master/types";

export class ConfigManager {
	private storage: Storage;
	private config: DebugMasterConfig | null = null;

	constructor() {
		this.storage = new Storage("debugging-master");
	}

	async load(): Promise<DebugMasterConfig> {
		if (this.config) return this.config;
		await this.storage.ensureDirs();
		const stored = await this.storage.getConfig<DebugMasterConfig>();
		this.config = stored ?? { projects: {} };
		return this.config;
	}

	async save(): Promise<void> {
		if (!this.config) return;
		await this.storage.setConfig(this.config);
	}

	async getProject(projectPath: string): Promise<ProjectConfig | null> {
		const config = await this.load();
		return config.projects[projectPath] ?? null;
	}

	async setProject(projectPath: string, project: ProjectConfig): Promise<void> {
		const config = await this.load();
		config.projects[projectPath] = project;
		await this.save();
	}

	async getRecentSession(): Promise<string | null> {
		const config = await this.load();
		return config.recentSession ?? null;
	}

	async setRecentSession(name: string): Promise<void> {
		const config = await this.load();
		config.recentSession = name;
		await this.save();
	}

	getStorage(): Storage {
		return this.storage;
	}

	getSessionsDir(): string {
		return `${this.storage.getBaseDir()}/sessions`;
	}
}
