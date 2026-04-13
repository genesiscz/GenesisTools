#!/usr/bin/env bun

import { isInteractive, suggestCommand } from "@app/utils/cli";
import type { ChannelConfigs } from "@app/utils/notifications";
import { dispatchNotification, notificationsConfig } from "@app/utils/notifications";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const MACOS_SOUNDS = [
    "Basso",
    "Blow",
    "Bottle",
    "Frog",
    "Funk",
    "Glass",
    "Hero",
    "Morse",
    "Ping",
    "Pop",
    "Purr",
    "Sosumi",
    "Submarine",
    "Tink",
];

function channelStatus(enabled: boolean): string {
    return enabled ? pc.green("enabled") : pc.dim("disabled");
}

async function configureSystem(channels: ChannelConfigs): Promise<void> {
    const current = channels.system;

    const enabled = await withCancel(
        p.confirm({ message: "Enable system (macOS) notifications?", initialValue: current.enabled })
    );

    if (!enabled) {
        await notificationsConfig.setGlobalChannel("system", { ...current, enabled: false });
        p.log.success("System notifications disabled.");
        return;
    }

    const title = await withCancel(
        p.text({
            message: "Default notification title",
            initialValue: current.title ?? "GenesisTools",
            placeholder: "GenesisTools",
        })
    );

    const sound = await withCancel(
        p.select({
            message: "Default sound",
            initialValue: current.sound ?? "Ping",
            options: MACOS_SOUNDS.map((s) => ({
                value: s,
                label: s,
                hint: s === current.sound ? "current" : undefined,
            })),
        })
    );

    const ignoreDnD = await withCancel(
        p.confirm({ message: "Bypass Do Not Disturb by default?", initialValue: current.ignoreDnD ?? false })
    );

    await notificationsConfig.setGlobalChannel("system", {
        enabled: true,
        title: title as string,
        sound: sound as string,
        ignoreDnD: ignoreDnD as boolean,
    });

    p.log.success("System notification settings saved.");
}

async function configureTelegram(channels: ChannelConfigs): Promise<void> {
    const current = channels.telegram;

    const enabled = await withCancel(
        p.confirm({ message: "Enable Telegram notifications?", initialValue: current.enabled })
    );

    if (!enabled) {
        await notificationsConfig.setGlobalChannel("telegram", { ...current, enabled: false });
        p.log.success("Telegram notifications disabled.");
        return;
    }

    const botToken = await withCancel(
        p.text({
            message: "Telegram bot token",
            initialValue: current.botToken ?? "",
            placeholder: "123456:ABC-DEF...",
            validate: (v) => (!v?.trim() ? "Bot token is required" : undefined),
        })
    );

    const chatId = await withCancel(
        p.text({
            message: "Telegram chat ID",
            initialValue: current.chatId ?? "",
            placeholder: "-1001234567890",
            validate: (v) => (!v?.trim() ? "Chat ID is required" : undefined),
        })
    );

    await notificationsConfig.setGlobalChannel("telegram", {
        enabled: true,
        botToken: (botToken as string).trim(),
        chatId: (chatId as string).trim(),
    });

    p.log.success("Telegram settings saved.");
}

async function configureWebhook(channels: ChannelConfigs): Promise<void> {
    const current = channels.webhook;

    const enabled = await withCancel(
        p.confirm({ message: "Enable webhook notifications?", initialValue: current.enabled })
    );

    if (!enabled) {
        await notificationsConfig.setGlobalChannel("webhook", { ...current, enabled: false });
        p.log.success("Webhook notifications disabled.");
        return;
    }

    const url = await withCancel(
        p.text({
            message: "Webhook URL",
            initialValue: current.url ?? "",
            placeholder: "https://hooks.example.com/...",
            validate: (v) => (!v?.trim() ? "URL is required" : undefined),
        })
    );

    await notificationsConfig.setGlobalChannel("webhook", {
        enabled: true,
        url: (url as string).trim(),
    });

    p.log.success("Webhook settings saved.");
}

async function configureSay(channels: ChannelConfigs): Promise<void> {
    const current = channels.say;

    const enabled = await withCancel(
        p.confirm({ message: "Enable TTS (say) notifications?", initialValue: current.enabled })
    );

    if (!enabled) {
        await notificationsConfig.setGlobalChannel("say", { ...current, enabled: false });
        p.log.success("TTS notifications disabled.");
        return;
    }

    const voice = await withCancel(
        p.text({
            message: "TTS voice name",
            initialValue: current.voice ?? "Samantha",
            placeholder: "Samantha",
        })
    );

    await notificationsConfig.setGlobalChannel("say", {
        enabled: true,
        voice: (voice as string).trim(),
    });

    p.log.success("TTS settings saved.");
}

function showCurrentConfig(channels: ChannelConfigs): void {
    const lines: string[] = [];

    lines.push(`${pc.bold("System (macOS)")}  ${channelStatus(channels.system.enabled)}`);
    lines.push(`  title:     ${channels.system.title ?? "—"}`);
    lines.push(`  sound:     ${channels.system.sound ?? "—"}`);
    lines.push(`  ignoreDnD: ${channels.system.ignoreDnD ? "yes" : "no"}`);
    lines.push("");

    lines.push(`${pc.bold("Telegram")}  ${channelStatus(channels.telegram.enabled)}`);
    lines.push(
        `  botToken:  ${channels.telegram.botToken ? pc.dim(`••••${channels.telegram.botToken.slice(-6)}`) : "—"}`
    );
    lines.push(`  chatId:    ${channels.telegram.chatId ?? "—"}`);
    lines.push("");

    lines.push(`${pc.bold("Webhook")}  ${channelStatus(channels.webhook.enabled)}`);
    lines.push(`  url:       ${channels.webhook.url ?? "—"}`);
    lines.push("");

    lines.push(`${pc.bold("TTS (say)")}  ${channelStatus(channels.say.enabled)}`);
    lines.push(`  voice:     ${channels.say.voice ?? "—"}`);

    p.note(lines.join("\n"), "Current notification config");
}

async function configCommand(): Promise<void> {
    if (!isInteractive()) {
        console.error("notify config requires an interactive terminal.");
        console.info(suggestCommand("tools notify", { add: ["--title", "Test", "Hello"] }));
        return;
    }

    p.intro(pc.bgCyan(pc.black(" notify config ")));

    while (true) {
        notificationsConfig.invalidate();
        const config = await notificationsConfig.load();
        const { channels } = config;

        const choice = await withCancel(
            p.select({
                message: "Configure notification channel",
                options: [
                    {
                        value: "system",
                        label: "System (macOS) notifications",
                        hint: channelStatus(channels.system.enabled),
                    },
                    { value: "telegram", label: "Telegram", hint: channelStatus(channels.telegram.enabled) },
                    { value: "webhook", label: "Webhook", hint: channelStatus(channels.webhook.enabled) },
                    { value: "say", label: "TTS (say)", hint: channelStatus(channels.say.enabled) },
                    { value: "show", label: "Show current config" },
                    { value: "back", label: "Back" },
                ],
            })
        );

        if (choice === "back") {
            break;
        }

        if (choice === "system") {
            await configureSystem(channels);
        } else if (choice === "telegram") {
            await configureTelegram(channels);
        } else if (choice === "webhook") {
            await configureWebhook(channels);
        } else if (choice === "say") {
            await configureSay(channels);
        } else if (choice === "show") {
            showCurrentConfig(channels);
        }
    }

    p.outro(pc.dim('Run `tools notify "test"` to try it out.'));
}

const program = new Command();

program
    .name("notify")
    .description("Send macOS notifications via terminal-notifier")
    .argument("[message]", "Notification message")
    .option("-t, --title <title>", "Notification title")
    .option("-s, --subtitle <subtitle>", "Notification subtitle")
    .option("--sound <sound>", "Notification sound name")
    .option("-g, --group <id>", "Group ID for deduplication")
    .option("--open <url>", "URL to open on click")
    .option("--execute <cmd>", "Shell command to run on click")
    .option("--app-icon <path>", "Custom icon path or URL")
    .option("--ignore-dnd", "Send even in Do Not Disturb mode")
    .option("--no-ignore-dnd", "Cancel ignore-dnd if set in config")
    .action(
        async (
            message: string | undefined,
            options: {
                title?: string;
                subtitle?: string;
                sound?: string;
                group?: string;
                open?: string;
                execute?: string;
                appIcon?: string;
                ignoreDnd?: boolean;
            }
        ) => {
            if (!message) {
                program.outputHelp();
                process.exit(0);
            }

            await dispatchNotification({
                app: "notify",
                message,
                title: options.title,
                subtitle: options.subtitle,
                sound: options.sound,
                group: options.group,
                open: options.open,
                execute: options.execute,
                appIcon: options.appIcon,
                ignoreDnD: options.ignoreDnd,
            });
        }
    );

program.command("config").description("Configure default notification settings").action(configCommand);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        process.exit(1);
    }
}

main();
