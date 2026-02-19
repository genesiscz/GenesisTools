import { Storage } from "@app/utils/storage/storage";

export interface AccountConfig {
	accessToken: string;
	label?: string;
}

export interface NotificationChannels {
	macos: boolean;
	telegram?: { botToken: string; chatId: string };
	webhook?: { url: string };
}

export interface NotificationConfig {
	sessionThresholds: number[];
	weeklyThresholds: number[];
	channels: NotificationChannels;
	watchInterval: number;
}

export interface ClaudeConfig {
	accounts: Record<string, AccountConfig>;
	defaultAccount?: string;
	notifications: NotificationConfig;
}

const DEFAULT_NOTIFICATIONS: NotificationConfig = {
	sessionThresholds: [80],
	weeklyThresholds: [20, 40, 60, 80],
	channels: { macos: true },
	watchInterval: 60,
};

const DEFAULT_CONFIG: ClaudeConfig = {
	accounts: {},
	notifications: DEFAULT_NOTIFICATIONS,
};

const storage = new Storage("claude");

export async function loadConfig(): Promise<ClaudeConfig> {
	const saved = await storage.getConfig<Partial<ClaudeConfig>>();
	if (!saved) return { ...DEFAULT_CONFIG };
	return {
		accounts: saved.accounts ?? {},
		defaultAccount: saved.defaultAccount,
		notifications: {
			...DEFAULT_NOTIFICATIONS,
			...saved.notifications,
			channels: {
				...DEFAULT_NOTIFICATIONS.channels,
				...saved.notifications?.channels,
			},
		},
	};
}

export async function saveConfig(config: ClaudeConfig): Promise<void> {
	await storage.setConfig(config);
}
