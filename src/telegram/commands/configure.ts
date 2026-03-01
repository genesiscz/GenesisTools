import { modelSelector } from "@ask/providers/ModelSelector";
import type { ProviderChoice } from "@ask/types";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Api } from "telegram";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import type {
    ActionType,
    AskModeConfig,
    ContactConfig,
    SuggestionModeConfig,
    TelegramConfigData,
    TelegramDialogType,
} from "../lib/types";
import {
    DEFAULT_MODE_CONFIG,
    DEFAULT_STYLE_PROFILE,
    DEFAULT_WATCH_CONFIG,
    DEFAULTS,
    TELEGRAM_CONFIG_VERSION,
} from "../lib/types";

interface DialogOption {
    id: string;
    label: string;
    hint?: string;
    dialogType: TelegramDialogType;
}

function isUser(entity: unknown): entity is Api.User {
    if (entity === null || entity === undefined || typeof entity !== "object") {
        return false;
    }

    if (!("className" in entity)) {
        return false;
    }

    return (entity as { className: string }).className === "User";
}

function isChat(entity: unknown): entity is Api.Chat {
    if (entity === null || entity === undefined || typeof entity !== "object") {
        return false;
    }

    if (!("className" in entity)) {
        return false;
    }

    return (entity as { className: string }).className === "Chat";
}

function isChannel(entity: unknown): entity is Api.Channel {
    if (entity === null || entity === undefined || typeof entity !== "object") {
        return false;
    }

    if (!("className" in entity)) {
        return false;
    }

    return (entity as { className: string }).className === "Channel";
}

async function promptCredentials(
    existing: TelegramConfigData | null
): Promise<{ apiId: number; apiHash: string } | null> {
    p.note("Telegram API credentials are pre-filled.\nGet your own at https://my.telegram.org/apps", "API Credentials");

    const apiId = await p.text({
        message: "API ID:",
        initialValue: String(existing?.apiId ?? DEFAULTS.apiId),
        validate: (value) => {
            if (!value || !/^\d+$/.test(value)) {
                return "Must be a number";
            }
        },
    });

    if (p.isCancel(apiId)) {
        return null;
    }

    const apiHash = await p.text({
        message: "API Hash:",
        initialValue: existing?.apiHash ?? DEFAULTS.apiHash,
        validate: (value) => {
            if (!value || !/^[a-f0-9]{32}$/.test(value)) {
                return "Must be 32 hex chars";
            }
        },
    });

    if (p.isCancel(apiHash)) {
        return null;
    }

    return { apiId: Number(apiId), apiHash: apiHash as string };
}

async function runAuthFlow(client: TGClient): Promise<boolean> {
    p.note(
        "You'll enter your phone number and a verification code.\nThis connects as YOUR user account (not a bot).",
        "Telegram Authentication"
    );

    try {
        await client.startWithAuth({
            phoneNumber: async () => {
                const phone = await p.text({
                    message: "Phone number (with country code):",
                    placeholder: "+420123456789",
                });

                if (p.isCancel(phone)) {
                    throw new Error("Cancelled");
                }

                return phone as string;
            },
            phoneCode: async () => {
                const code = await p.text({
                    message: "Verification code (check Telegram):",
                    placeholder: "12345",
                });

                if (p.isCancel(code)) {
                    throw new Error("Cancelled");
                }

                return code as string;
            },
            password: async () => {
                const password = await p.password({
                    message: "2FA password (if enabled):",
                });

                if (p.isCancel(password)) {
                    throw new Error("Cancelled");
                }

                return password as string;
            },
        });

        p.log.success("Authenticated successfully!");
        return true;
    } catch (err) {
        p.log.error(`Authentication failed: ${err}`);
        return false;
    }
}

async function fetchDialogs(client: TGClient): Promise<DialogOption[]> {
    const spinner = p.spinner();
    spinner.start("Fetching your recent dialogs...");

    const dialogs = await client.getDialogs(200);
    const options: DialogOption[] = [];

    for (const dialog of dialogs) {
        const entity = dialog.entity;

        if (!entity) {
            continue;
        }

        if (isUser(entity)) {
            if (entity.bot || entity.self) {
                continue;
            }

            const label = `${entity.firstName || ""} ${entity.lastName || ""}`.trim() || entity.id.toString();
            options.push({
                id: entity.id.toString(),
                label,
                hint: entity.username ? `@${entity.username}` : entity.phone ? `+${entity.phone}` : undefined,
                dialogType: "user",
            });
            continue;
        }

        if (isChat(entity)) {
            options.push({
                id: entity.id.toString(),
                label: entity.title,
                hint: "group",
                dialogType: "group",
            });
            continue;
        }

        if (isChannel(entity)) {
            options.push({
                id: entity.id.toString(),
                label: entity.title,
                hint: entity.username ? `@${entity.username}` : "channel",
                dialogType: "channel",
            });
        }
    }

    spinner.stop(`Found ${options.length} dialogs`);
    return options;
}

async function selectDialogs(options: DialogOption[], existingContacts: ContactConfig[]): Promise<string[] | null> {
    const existingIds = new Set(existingContacts.map((contact) => contact.userId));
    const selected = await p.multiselect({
        message: "Select dialogs to watch:",
        options: options.map((option) => ({
            value: option.id,
            label: option.label,
            hint: option.hint,
        })),
        initialValues: [...existingIds].filter((id) => options.some((option) => option.id === id)),
        required: false,
    });

    if (p.isCancel(selected)) {
        return null;
    }

    return selected as string[];
}

async function chooseProviderModel(existingProvider?: string, existingModel?: string): Promise<ProviderChoice | null> {
    if (existingProvider && existingModel) {
        const exact = await modelSelector.selectModelByName(existingProvider, existingModel);

        if (exact) {
            const reuse = await p.confirm({
                message: `Reuse ${existingProvider}/${existingModel}?`,
                initialValue: true,
            });

            if (!p.isCancel(reuse) && reuse) {
                return exact;
            }
        }
    }

    return modelSelector.selectModel();
}

async function promptAskModeConfig(
    label: string,
    defaults: AskModeConfig,
    existing: AskModeConfig | undefined,
    initialEnabled: boolean
): Promise<AskModeConfig | null> {
    const enabled = await p.confirm({
        message: `Enable ${label}?`,
        initialValue: existing?.enabled ?? initialEnabled,
    });

    if (p.isCancel(enabled)) {
        return null;
    }

    const result: AskModeConfig = {
        ...defaults,
        ...existing,
        enabled,
    };

    if (!enabled) {
        return result;
    }

    const choice = await chooseProviderModel(result.provider, result.model);

    if (!choice) {
        return null;
    }

    result.provider = choice.provider.name;
    result.model = choice.model.id;

    const systemPrompt = await p.text({
        message: `${label} system prompt:`,
        initialValue: result.systemPrompt ?? DEFAULTS.askSystemPrompt,
    });

    if (p.isCancel(systemPrompt)) {
        return null;
    }

    result.systemPrompt = systemPrompt as string;

    const temperatureInput = await p.text({
        message: `${label} temperature:`,
        initialValue: String(result.temperature ?? DEFAULTS.askTemperature),
        validate: (value) => {
            const parsed = Number(value);

            if (Number.isNaN(parsed) || parsed < 0 || parsed > 2) {
                return "Use number between 0 and 2";
            }
        },
    });

    if (p.isCancel(temperatureInput)) {
        return null;
    }

    result.temperature = Number(temperatureInput);

    const maxTokensInput = await p.text({
        message: `${label} max tokens:`,
        initialValue: String(result.maxTokens ?? DEFAULTS.askMaxTokens),
        validate: (value) => {
            const parsed = Number(value);

            if (!Number.isInteger(parsed) || parsed <= 0) {
                return "Use positive integer";
            }
        },
    });

    if (p.isCancel(maxTokensInput)) {
        return null;
    }

    result.maxTokens = Number(maxTokensInput);

    return result;
}

async function promptSuggestionModeConfig(
    existing: SuggestionModeConfig | undefined
): Promise<SuggestionModeConfig | null> {
    const base = await promptAskModeConfig(
        "Suggestion mode",
        DEFAULT_MODE_CONFIG.suggestions,
        existing,
        DEFAULT_MODE_CONFIG.suggestions.enabled
    );

    if (!base) {
        return null;
    }

    const result: SuggestionModeConfig = {
        ...DEFAULT_MODE_CONFIG.suggestions,
        ...existing,
        ...base,
    };

    if (!result.enabled) {
        return result;
    }

    const countInput = await p.text({
        message: "How many suggestions (1-5)?",
        initialValue: String(result.count),
        validate: (value) => {
            const parsed = Number(value);

            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
                return "Enter integer from 1 to 5";
            }
        },
    });

    if (p.isCancel(countInput)) {
        return null;
    }

    result.count = Number(countInput);

    const trigger = await p.select({
        message: "Suggestion trigger mode:",
        options: [
            { value: "manual" as const, label: "Manual only (/suggest)" },
            { value: "auto" as const, label: "Auto on every incoming message" },
            { value: "hybrid" as const, label: "Manual + auto with debounce" },
        ],
        initialValue: result.trigger,
    });

    if (p.isCancel(trigger)) {
        return null;
    }

    result.trigger = trigger;

    const delayInput = await p.text({
        message: "Auto suggestion debounce delay (ms):",
        initialValue: String(result.autoDelayMs),
        validate: (value) => {
            const parsed = Number(value);

            if (!Number.isInteger(parsed) || parsed < 0) {
                return "Enter non-negative integer";
            }
        },
    });

    if (p.isCancel(delayInput)) {
        return null;
    }

    result.autoDelayMs = Number(delayInput);

    const allowAutoSend = await p.confirm({
        message: "Allow automatic sending of top suggestion?",
        initialValue: result.allowAutoSend,
    });

    if (p.isCancel(allowAutoSend)) {
        return null;
    }

    result.allowAutoSend = allowAutoSend;

    return result;
}

async function configureContact(option: DialogOption, existing?: ContactConfig): Promise<ContactConfig | null> {
    p.log.step(pc.bold(option.label));

    const actions = await p.multiselect({
        message: `Actions for ${option.label}:`,
        options: [
            { value: "say" as const, label: "Say aloud", hint: "macOS TTS" },
            { value: "ask" as const, label: "Auto-reply", hint: "AI response" },
            { value: "notify" as const, label: "Notification", hint: "Desktop notification" },
        ],
        initialValues: existing?.actions ?? ["notify"],
        required: true,
    });

    if (p.isCancel(actions)) {
        return null;
    }

    const contextLengthInput = await p.text({
        message: "Watch context length (messages):",
        initialValue: String(existing?.watch?.contextLength ?? DEFAULT_WATCH_CONFIG.contextLength),
        validate: (value) => {
            const parsed = Number(value);

            if (!Number.isInteger(parsed) || parsed < 1) {
                return "Enter a positive integer";
            }
        },
    });

    if (p.isCancel(contextLengthInput)) {
        return null;
    }

    const runtimeMode = await p.select({
        message: "Preferred runtime:",
        options: [
            { value: "daemon" as const, label: "daemon" },
            { value: "light" as const, label: "light" },
            { value: "ink" as const, label: "ink" },
        ],
        initialValue: existing?.watch?.runtimeMode ?? DEFAULT_WATCH_CONFIG.runtimeMode,
    });

    if (p.isCancel(runtimeMode)) {
        return null;
    }

    const autoReply = await promptAskModeConfig(
        "Auto reply",
        DEFAULT_MODE_CONFIG.autoReply,
        existing?.modes?.autoReply,
        (actions as ActionType[]).includes("ask")
    );

    if (!autoReply) {
        return null;
    }

    const assistantMode = await promptAskModeConfig(
        "Assistant mode",
        DEFAULT_MODE_CONFIG.assistant,
        existing?.modes?.assistant,
        true
    );

    if (!assistantMode) {
        return null;
    }

    const suggestionMode = await promptSuggestionModeConfig(existing?.modes?.suggestions);

    if (!suggestionMode) {
        return null;
    }

    return {
        userId: option.id,
        displayName: option.label,
        username: undefined,
        dialogType: option.dialogType,
        actions: actions as ActionType[],
        modes: {
            autoReply,
            assistant: assistantMode,
            suggestions: suggestionMode,
        },
        watch: {
            enabled: true,
            contextLength: Number(contextLengthInput),
            runtimeMode,
        },
        styleProfile: existing?.styleProfile ?? { ...DEFAULT_STYLE_PROFILE },
        replyDelayMin: existing?.replyDelayMin ?? DEFAULTS.replyDelayMin,
        replyDelayMax: existing?.replyDelayMax ?? DEFAULTS.replyDelayMax,
        askProvider: autoReply.provider,
        askModel: autoReply.model,
        askSystemPrompt: autoReply.systemPrompt,
    };
}

export function registerConfigureCommand(program: Command): void {
    program
        .command("configure")
        .description("Set up Telegram MTProto client with guided wizard")
        .action(async () => {
            p.intro(pc.bgMagenta(pc.white(" telegram configure ")));

            const toolConfig = new TelegramToolConfig();
            const existing = await toolConfig.load();
            let client: TGClient | null = null;

            if (existing?.session) {
                const spinner = p.spinner();
                spinner.start("Checking existing session...");

                client = TGClient.fromConfig(toolConfig);
                const authorized = await client.connect();

                if (authorized) {
                    spinner.stop("Session valid");
                    const me = await client.getMe();
                    p.log.success(
                        `Logged in as ${pc.bold(me.firstName || "")} ${me.username ? `(@${me.username})` : ""}`
                    );
                } else {
                    spinner.stop("Session expired — re-authentication needed");
                    await client.disconnect();
                    client = null;
                }
            }

            let effectiveApiId = toolConfig.getApiId();
            let effectiveApiHash = toolConfig.getApiHash();

            if (!client) {
                const credentials = await promptCredentials(existing);

                if (!credentials) {
                    return;
                }

                effectiveApiId = credentials.apiId;
                effectiveApiHash = credentials.apiHash;
                client = new TGClient(credentials.apiId, credentials.apiHash);

                const ok = await runAuthFlow(client);

                if (!ok) {
                    p.outro("Please try again.");
                    return;
                }
            }

            const me = await client.getMe();
            const session = client.getSessionString();
            const dialogOptions = await fetchDialogs(client);

            if (dialogOptions.length === 0) {
                p.log.warn("No dialogs found in recent chats.");
                await toolConfig.save({
                    version: TELEGRAM_CONFIG_VERSION,
                    apiId: effectiveApiId,
                    apiHash: effectiveApiHash,
                    session,
                    me: {
                        firstName: me.firstName || "",
                        username: me.username ?? undefined,
                        phone: me.phone ?? undefined,
                    },
                    defaults: existing?.defaults,
                    contacts: [],
                    configuredAt: new Date().toISOString(),
                });
                await client.disconnect();
                p.outro("Configuration saved (no dialogs to watch).");
                return;
            }

            const selectedIds = await selectDialogs(dialogOptions, existing?.contacts ?? []);

            if (!selectedIds) {
                await client.disconnect();
                return;
            }

            const contacts: ContactConfig[] = [];

            for (const id of selectedIds) {
                const option = dialogOptions.find((candidate) => candidate.id === id);

                if (!option) {
                    continue;
                }

                const existingContact = existing?.contacts.find((contact) => contact.userId === id);
                const configured = await configureContact(option, existingContact);

                if (!configured) {
                    await client.disconnect();
                    return;
                }

                contacts.push(configured);
            }

            await toolConfig.save({
                version: TELEGRAM_CONFIG_VERSION,
                apiId: effectiveApiId,
                apiHash: effectiveApiHash,
                session,
                me: {
                    firstName: me.firstName || "",
                    username: me.username ?? undefined,
                    phone: me.phone ?? undefined,
                },
                defaults: existing?.defaults ?? {
                    autoReply: { ...DEFAULT_MODE_CONFIG.autoReply },
                    assistant: { ...DEFAULT_MODE_CONFIG.assistant },
                    suggestions: { ...DEFAULT_MODE_CONFIG.suggestions },
                },
                contacts,
                configuredAt: new Date().toISOString(),
            });

            await client.disconnect();
            p.log.success(`Saved ${contacts.length} contact(s)`);
            p.outro("Run: tools telegram watch --all");
        });
}
