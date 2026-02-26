import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Api } from "telegram";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import type { ActionType, ContactConfig, TelegramConfigData } from "../lib/types";
import { DEFAULTS } from "../lib/types";

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
    existing: TelegramConfigData | null
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

interface ContactOption {
    userId: string;
    label: string;
    hint: string;
    user: Api.User;
}

async function fetchContacts(client: TGClient): Promise<ContactOption[]> {
    const spinner = p.spinner();
    spinner.start("Fetching your recent chats...");

    const dialogs = await client.getDialogs(100);

    const userDialogs = dialogs.filter((d) => d.isUser && isUser(d.entity) && !d.entity.bot && !d.entity.self);

    spinner.stop(`Found ${userDialogs.length} contacts`);

    return userDialogs
        .filter((d): d is typeof d & { entity: Api.User } => isUser(d.entity))
        .map((d) => {
            const user = d.entity;
            const label = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.id.toString();
            const hint = user.username ? `@${user.username}` : user.phone ? `+${user.phone}` : "";
            return { userId: user.id.toString(), label, hint, user };
        });
}

async function selectContacts(options: ContactOption[], existingContacts: ContactConfig[]): Promise<string[] | null> {
    const existingIds = new Set(existingContacts.map((c) => c.userId));

    const selected = await p.multiselect({
        message: "Select contacts to watch:",
        options: options.map((o) => ({ value: o.userId, label: o.label, hint: o.hint })),
        initialValues: [...existingIds].filter((id) => options.some((o) => o.userId === id)),
        required: false,
    });

    if (p.isCancel(selected)) {
        return null;
    }

    return selected as string[];
}

async function configureContactActions(opt: ContactOption, existing?: ContactConfig): Promise<ContactConfig | null> {
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
    let askSystemPrompt: string | undefined;
    let askProvider: string | undefined;
    let askModel: string | undefined;

    if (typedActions.includes("ask")) {
        const prompt = await p.text({
            message: `System prompt for auto-replies to ${opt.label}:`,
            initialValue: existing?.askSystemPrompt || DEFAULTS.askSystemPrompt,
        });

        if (p.isCancel(prompt)) {
            return null;
        }

        askSystemPrompt = prompt as string;

        const provider = await p.text({
            message: "LLM provider:",
            initialValue: existing?.askProvider || DEFAULTS.askProvider,
        });

        if (p.isCancel(provider)) {
            return null;
        }

        askProvider = provider as string;

        const model = await p.text({
            message: "LLM model:",
            initialValue: existing?.askModel || DEFAULTS.askModel,
        });

        if (p.isCancel(model)) {
            return null;
        }

        askModel = model as string;
    }

    return {
        userId: opt.userId,
        displayName: opt.label,
        username: opt.user.username ?? undefined,
        actions: typedActions,
        askSystemPrompt,
        askProvider,
        askModel,
        replyDelayMin: existing?.replyDelayMin ?? DEFAULTS.replyDelayMin,
        replyDelayMax: existing?.replyDelayMax ?? DEFAULTS.replyDelayMax,
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
                        `Logged in as ${pc.bold(me.firstName || "")} ` + `${me.username ? `(@${me.username})` : ""}`
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

            const contactOptions = await fetchContacts(client);

            if (contactOptions.length === 0) {
                p.log.warn("No contacts found in recent chats.");
                await toolConfig.save({
                    apiId: effectiveApiId,
                    apiHash: effectiveApiHash,
                    session,
                    me: {
                        firstName: me.firstName || "",
                        username: me.username ?? undefined,
                        phone: me.phone ?? undefined,
                    },
                    contacts: [],
                    configuredAt: new Date().toISOString(),
                });
                await client.disconnect();
                p.outro("Configuration saved (no contacts to watch).");
                return;
            }

            const selectedIds = await selectContacts(contactOptions, existing?.contacts ?? []);

            if (!selectedIds) {
                await client.disconnect();
                return;
            }

            const contacts: ContactConfig[] = [];

            for (const userId of selectedIds) {
                const opt = contactOptions.find((o) => o.userId === userId);

                if (!opt) {
                    continue;
                }

                const existingContact = existing?.contacts.find((c) => c.userId === userId);
                const contact = await configureContactActions(opt, existingContact);

                if (!contact) {
                    await client.disconnect();
                    return;
                }

                contacts.push(contact);
            }

            await toolConfig.save({
                apiId: effectiveApiId,
                apiHash: effectiveApiHash,
                session,
                me: {
                    firstName: me.firstName || "",
                    username: me.username ?? undefined,
                    phone: me.phone ?? undefined,
                },
                contacts,
                configuredAt: new Date().toISOString(),
            });

            await client.disconnect();

            p.log.success(`Saved ${contacts.length} contact(s)`);
            p.outro("Run: tools telegram listen");
        });
}
