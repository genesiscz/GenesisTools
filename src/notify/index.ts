#!/usr/bin/env bun

import { sendNotification } from "@app/utils/macos/notifications";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import { Storage } from "@app/utils/storage/storage";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

interface NotifyConfig {
    title: string;
    sound: string;
    ignoreDnD: boolean;
    say: boolean;
}

const DEFAULT_CONFIG: NotifyConfig = {
    title: "GenesisTools",
    sound: "Ping",
    ignoreDnD: false,
    say: false,
};

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

const storage = new Storage("notify");

async function getConfig(): Promise<NotifyConfig> {
    const saved = await storage.getConfig<Partial<NotifyConfig>>();
    return { ...DEFAULT_CONFIG, ...saved };
}

async function configCommand(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" notify config ")));

    const current = await getConfig();

    const title = await withCancel(
        p.text({
            message: "Default notification title",
            initialValue: current.title,
            placeholder: "GenesisTools",
        })
    );

    const sound = await withCancel(
        p.select({
            message: "Default sound",
            initialValue: current.sound,
            options: MACOS_SOUNDS.map((s) => ({
                value: s,
                label: s,
                hint: s === current.sound ? "current" : undefined,
            })),
        })
    );

    const ignoreDnD = await withCancel(
        p.confirm({
            message: "Bypass Do Not Disturb by default?",
            initialValue: current.ignoreDnD,
        })
    );

    const say = await withCancel(
        p.confirm({
            message: "Also speak notifications via TTS by default?",
            initialValue: current.say,
        })
    );

    const config: NotifyConfig = {
        title: title as string,
        sound: sound as string,
        ignoreDnD: ignoreDnD as boolean,
        say: say as boolean,
    };

    await storage.setConfig(config);
    p.log.success("Configuration saved.");
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
    .option("--say", "Also speak the message via TTS")
    .option("--no-say", "Cancel say if set in config")
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
                say?: boolean;
            }
        ) => {
            if (!message) {
                program.outputHelp();
                process.exit(0);
            }

            const config = await getConfig();

            await sendNotification({
                message,
                title: options.title ?? config.title,
                subtitle: options.subtitle,
                sound: options.sound ?? config.sound,
                group: options.group,
                open: options.open,
                execute: options.execute,
                appIcon: options.appIcon,
                ignoreDnD: options.ignoreDnd ?? config.ignoreDnD,
                say: options.say ?? config.say,
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
