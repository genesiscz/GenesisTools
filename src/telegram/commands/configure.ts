import { ModelSelector } from "@app/ask/index.lib";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Api } from "telegram";
import type { Dialog } from "telegram/tl/custom/dialog";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import type {
    ActionType,
    ChatType,
    ContactModesConfig,
    TelegramConfigDataV2,
    TelegramContactV2,
    WatchConfig,
} from "../lib/types";
import { DEFAULT_MODE_CONFIG, DEFAULT_STYLE_PROFILE, DEFAULT_WATCH_CONFIG, DEFAULTS } from "../lib/types";

function isUser(entity: unknown): entity is Api.User {
    return (
        entity !== null &&
        entity !== undefined &&
        typeof entity === "object" &&
        "className" in entity &&
        (entity as { className: string }).className === "User"
    );
}

async function promptCredentials(
    existing: TelegramConfigDataV2 | null
): Promise<{ apiId: number; apiHash: string } | null> {
    p.note("Telegram API credentials are pre-filled.\nGet your own at https://my.telegram.org/apps", "API Credentials");

    const apiId = await p.text({
        message: "API ID:",
        initialValue: String(existing?.apiId ?? DEFAULTS.apiId),
        validate: (v) => {
            if (!v || !/^\d+$/.test(v)) {
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
        validate: (v) => {
            if (!v || !/^[a-f0-9]{32}$/.test(v)) {
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
                const pass = await p.password({
                    message: "2FA password (if enabled):",
                });

                if (p.isCancel(pass)) {
                    throw new Error("Cancelled");
                }

                return pass as string;
            },
        });

        p.log.success("Authenticated successfully!");
        return true;
    } catch (err) {
        p.log.error(`Authentication failed: ${err}`);
        return false;
    }
}

interface DialogOption {
    dialog: Dialog;
    chatType: ChatType;
    entityId: string;
    dialogKey: string;
    label: string;
    hint: string;
}

function classifyDialog(d: Dialog): { chatType: ChatType; entityId: string; dialogKey: string } | null {
    if (!d.entity) {
        return null;
    }

    if (d.isUser && isUser(d.entity) && !d.entity.bot && !d.entity.self) {
        const entityId = d.entity.id.toString();
        return { chatType: "user", entityId, dialogKey: `user:${entityId}` };
    }

    if (d.isGroup && d.entity.id) {
        const entityId = d.entity.id.toString();
        return { chatType: "group", entityId, dialogKey: `group:${entityId}` };
    }

    if (d.isChannel && d.entity.id) {
        const entityId = d.entity.id.toString();
        return { chatType: "channel", entityId, dialogKey: `channel:${entityId}` };
    }

    return null;
}

async function fetchDialogOptions(client: TGClient): Promise<DialogOption[]> {
    const spinner = p.spinner();
    spinner.start("Fetching your recent chats...");
    const options: DialogOption[] = [];

    try {
        const dialogs = await client.getDialogs(200);

        for (const d of dialogs) {
            const classified = classifyDialog(d);

            if (!classified) {
                continue;
            }

            const entity = d.entity as { username?: string; phone?: string; id: { toString(): string } };
            const username = "username" in entity ? entity.username : undefined;
            const typePrefix = classified.chatType === "user" ? "U" : classified.chatType === "group" ? "G" : "C";
            const label = `[${typePrefix}] ${d.title || classified.entityId}`;
            const hint = username ? `@${username}` : "";

            options.push({
                dialog: d,
                chatType: classified.chatType,
                entityId: classified.entityId,
                dialogKey: classified.dialogKey,
                label,
                hint,
            });
        }

        return options;
    } finally {
        spinner.stop(`Found ${options.length} chats`);
    }
}

async function selectDialogs(options: DialogOption[], existingContacts: TelegramContactV2[]): Promise<string[] | null> {
    const existingDialogKeys = new Set(existingContacts.map((c) => `${c.chatType}:${c.userId}`));

    const selected = await p.multiselect({
        message: "Select chats to watch:",
        options: options.map((o) => ({ value: o.dialogKey, label: o.label, hint: o.hint })),
        initialValues: options.filter((o) => existingDialogKeys.has(o.dialogKey)).map((o) => o.dialogKey),
        required: false,
    });

    if (p.isCancel(selected)) {
        return null;
    }

    return selected as string[];
}

async function configureContactModes(
    displayName: string,
    existing?: TelegramContactV2
): Promise<ContactModesConfig | null> {
    const modeChoices = await p.multiselect({
        message: `Which AI modes for ${displayName}?`,
        options: [
            { value: "autoReply" as const, label: "Auto-Reply", hint: "Automatically respond to messages" },
            { value: "assistant" as const, label: "Chat Assistant", hint: "Ask questions about the conversation" },
            {
                value: "suggestions" as const,
                label: "Message Suggestions",
                hint: "Get suggested replies to pick/edit/send",
            },
        ],
        initialValues: getExistingEnabledModes(existing),
        required: false,
    });

    if (p.isCancel(modeChoices)) {
        return null;
    }

    const selectedModes = modeChoices as string[];
    const modes: ContactModesConfig = {
        autoReply: { ...DEFAULT_MODE_CONFIG.autoReply },
        assistant: { ...DEFAULT_MODE_CONFIG.assistant },
        suggestions: { ...DEFAULT_MODE_CONFIG.suggestions },
    };

    const modelSelector = new ModelSelector();

    for (const mode of selectedModes) {
        const configureModel = await p.confirm({
            message: `Configure custom model for ${mode}?`,
            initialValue: false,
        });

        if (p.isCancel(configureModel)) {
            return null;
        }

        if (mode === "autoReply") {
            modes.autoReply = { ...modes.autoReply, enabled: true };
        } else if (mode === "assistant") {
            modes.assistant = { ...modes.assistant, enabled: true };
        } else if (mode === "suggestions") {
            modes.suggestions = { ...modes.suggestions, enabled: true };
        }

        if (configureModel) {
            const choice = await modelSelector.selectModel();

            if (choice && !p.isCancel(choice)) {
                if (mode === "autoReply") {
                    modes.autoReply = {
                        ...modes.autoReply,
                        provider: choice.provider.name,
                        model: choice.model.id,
                    };
                } else if (mode === "assistant") {
                    modes.assistant = {
                        ...modes.assistant,
                        provider: choice.provider.name,
                        model: choice.model.id,
                    };
                } else if (mode === "suggestions") {
                    modes.suggestions = {
                        ...modes.suggestions,
                        provider: choice.provider.name,
                        model: choice.model.id,
                    };
                }
            }
        }
    }

    return modes;
}

function getExistingEnabledModes(existing?: TelegramContactV2): string[] {
    if (!existing?.modes) {
        return ["assistant", "suggestions"];
    }

    const enabled: string[] = [];

    if (existing.modes.autoReply.enabled) {
        enabled.push("autoReply");
    }

    if (existing.modes.assistant.enabled) {
        enabled.push("assistant");
    }

    if (existing.modes.suggestions.enabled) {
        enabled.push("suggestions");
    }

    return enabled;
}

async function configureContactActions(
    opt: DialogOption,
    existing?: TelegramContactV2
): Promise<TelegramContactV2 | null> {
    p.log.step(pc.bold(opt.label));

    const actions = await p.multiselect({
        message: `Actions for ${opt.label}:`,
        options: [
            { value: "say" as const, label: "Say aloud", hint: "macOS TTS with language detection" },
            { value: "ask" as const, label: "Auto-reply", hint: "LLM generates reply via tools ask" },
            { value: "notify" as const, label: "Notification", hint: "macOS notification" },
        ],
        initialValues: existing?.actions ?? ["notify"],
        required: true,
    });

    if (p.isCancel(actions)) {
        return null;
    }

    const typedActions = actions as ActionType[];

    let systemPrompt: string | undefined;

    if (typedActions.includes("ask")) {
        const prompt = await p.text({
            message: `System prompt for auto-replies to ${opt.label}:`,
            initialValue: existing?.modes?.autoReply?.systemPrompt || DEFAULTS.askSystemPrompt,
        });

        if (p.isCancel(prompt)) {
            return null;
        }

        systemPrompt = prompt as string;
    }

    const modes = await configureContactModes(opt.label, existing);

    if (!modes) {
        return null;
    }

    if (systemPrompt && modes.autoReply.enabled) {
        modes.autoReply.systemPrompt = systemPrompt;
    }

    const contextLength = await p.text({
        message: "Context window size (number of recent messages)?",
        initialValue: String(existing?.watch?.contextLength ?? 30),
        validate: (v) => {
            if (!v) {
                return "Required";
            }

            const n = Number.parseInt(v, 10);

            if (Number.isNaN(n) || n < 1 || n > 500) {
                return "Must be 1-500";
            }
        },
    });

    if (p.isCancel(contextLength)) {
        return null;
    }

    const watchConfig: WatchConfig = {
        enabled: true,
        contextLength: Number.parseInt(contextLength as string, 10),
        runtimeMode: existing?.watch?.runtimeMode ?? "ink",
    };

    return {
        userId: opt.entityId,
        displayName: opt.dialog.title || opt.entityId,
        username: getEntityUsername(opt.dialog),
        chatType: opt.chatType,
        actions: typedActions,
        watch: watchConfig,
        modes,
        styleProfile: existing?.styleProfile ?? { ...DEFAULT_STYLE_PROFILE },
        replyDelayMin: existing?.replyDelayMin ?? DEFAULTS.replyDelayMin,
        replyDelayMax: existing?.replyDelayMax ?? DEFAULTS.replyDelayMax,
    };
}

function getEntityUsername(dialog: Dialog): string | undefined {
    const entity = dialog.entity;

    if (!entity) {
        return undefined;
    }

    if ("username" in entity && typeof entity.username === "string") {
        return entity.username;
    }

    return undefined;
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
                        `Logged in as ${pc.bold(me.firstName || "")} ` + `${me.username ? `(@${me.username})` : ""}`
                    );
                } else {
                    spinner.stop("Session expired -- re-authentication needed");
                    await client.disconnect();
                    client = null;
                }
            }

            let effectiveApiId = toolConfig.getApiId();
            let effectiveApiHash = toolConfig.getApiHash();

            if (!client) {
                const creds = await promptCredentials(existing);

                if (!creds) {
                    return;
                }

                effectiveApiId = creds.apiId;
                effectiveApiHash = creds.apiHash;
                client = new TGClient(creds.apiId, creds.apiHash);

                const ok = await runAuthFlow(client);

                if (!ok) {
                    p.outro("Please try again.");
                    return;
                }
            }

            const me = await client.getMe();
            const session = client.getSessionString();

            const dialogOptions = await fetchDialogOptions(client);

            if (dialogOptions.length === 0) {
                p.log.warn("No chats found.");
                const emptyConfig: TelegramConfigDataV2 = {
                    version: 2,
                    apiId: effectiveApiId,
                    apiHash: effectiveApiHash,
                    session,
                    me: {
                        firstName: me.firstName || "",
                        username: me.username ?? undefined,
                        phone: me.phone ?? undefined,
                    },
                    contacts: [],
                    globalDefaults: {
                        modes: { ...DEFAULT_MODE_CONFIG },
                        watch: { ...DEFAULT_WATCH_CONFIG },
                        styleProfile: { ...DEFAULT_STYLE_PROFILE },
                    },
                    configuredAt: new Date().toISOString(),
                };
                await toolConfig.save(emptyConfig);
                await client.disconnect();
                p.outro("Configuration saved (no contacts to watch).");
                return;
            }

            const selectedIds = await selectDialogs(dialogOptions, existing?.contacts ?? []);

            if (!selectedIds) {
                await client.disconnect();
                return;
            }

            const contacts: TelegramContactV2[] = [];

            for (const dialogKey of selectedIds) {
                const opt = dialogOptions.find((o) => o.dialogKey === dialogKey);

                if (!opt) {
                    continue;
                }

                const existingContact = existing?.contacts.find((c) => `${c.chatType}:${c.userId}` === dialogKey);
                const contact = await configureContactActions(opt, existingContact);

                if (!contact) {
                    await client.disconnect();
                    return;
                }

                contacts.push(contact);
            }

            const configToSave: TelegramConfigDataV2 = {
                version: 2,
                apiId: effectiveApiId,
                apiHash: effectiveApiHash,
                session,
                me: {
                    firstName: me.firstName || "",
                    username: me.username ?? undefined,
                    phone: me.phone ?? undefined,
                },
                contacts,
                globalDefaults: existing?.globalDefaults ?? {
                    modes: { ...DEFAULT_MODE_CONFIG },
                    watch: { ...DEFAULT_WATCH_CONFIG },
                    styleProfile: { ...DEFAULT_STYLE_PROFILE },
                },
                configuredAt: new Date().toISOString(),
            };

            await toolConfig.save(configToSave);
            await client.disconnect();

            p.log.success(`Saved ${contacts.length} contact(s)`);
            p.outro("Run: tools telegram listen");
        });
}
