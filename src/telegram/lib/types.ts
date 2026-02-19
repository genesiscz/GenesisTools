export type ActionType = "say" | "ask" | "notify";

export interface ContactConfig {
	userId: string;
	displayName: string;
	username?: string;
	actions: ActionType[];
	askSystemPrompt?: string;
	askProvider?: string;
	askModel?: string;
	replyDelayMin: number;
	replyDelayMax: number;
}

export interface TelegramConfigData {
	apiId: number;
	apiHash: string;
	session: string;
	me?: { firstName: string; username?: string; phone?: string };
	contacts: ContactConfig[];
	configuredAt: string;
}

export interface ActionResult {
	action: ActionType;
	success: boolean;
	reply?: string;
	duration: number;
	error?: unknown;
}

export type ActionHandler = (
	message: import("./TelegramMessage").TelegramMessage,
	contact: import("./TelegramContact").TelegramContact,
	client: import("./TGClient").TGClient,
) => Promise<ActionResult>;

export const DEFAULTS = {
	apiId: 39398121,
	apiHash: "d1857dc6fabd4d7034795dd3bd6ac0d1",
	replyDelayMin: 2000,
	replyDelayMax: 5000,
	askSystemPrompt:
		"You're chatting casually on Telegram. Reply naturally and briefly (1-2 sentences). Match the language of the incoming message.",
	connectionRetries: 5,
	maxProcessedMessages: 500,
	typingIntervalMs: 4000,
	askTimeoutMs: 60_000,
	askProvider: "openai",
	askModel: "gpt-4o-mini",
} as const;
