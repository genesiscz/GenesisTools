import { Monitor } from "@app/monitor/lib/monitor";
import { describeTarget } from "@app/monitor/lib/notify-targets";
import { isNotifyChannel, NOTIFY_CHANNELS, type NotifyTarget } from "@app/monitor/lib/types";
import {
    parseEntityId,
    parseNotifyTargetInput,
    parseNotifyTargetPatch,
    WatcherValidationError,
} from "@app/monitor/lib/validate";
import { suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

interface TargetFlags {
    name?: string;
    channel?: string | true;
    sound?: string;
    title?: string;
    ignoreDnd?: boolean;
    voice?: string;
    provider?: string;
    botToken?: string;
    chatId?: string;
    url?: string;
    enabled?: boolean;
    json?: boolean;
}

function configFromFlags(flags: TargetFlags): Record<string, string | boolean> {
    const config: Record<string, string | boolean> = {};
    const strings: Array<[keyof TargetFlags, string]> = [
        ["sound", "sound"],
        ["title", "title"],
        ["voice", "voice"],
        ["provider", "provider"],
        ["botToken", "botToken"],
        ["chatId", "chatId"],
        ["url", "url"],
    ];

    for (const [flag, key] of strings) {
        const value = flags[flag];

        if (typeof value === "string") {
            config[key] = value;
        }
    }

    if (flags.ignoreDnd !== undefined) {
        config.ignoreDnD = flags.ignoreDnd;
    }

    return config;
}

async function withMonitor<T>(fn: (monitor: Monitor) => Promise<T>): Promise<T> {
    const monitor = new Monitor();

    try {
        return await fn(monitor);
    } finally {
        await monitor.close();
    }
}

async function requireTarget(monitor: Monitor, raw: string): Promise<NotifyTarget> {
    const target = await monitor.getTarget(parseEntityId(raw, "target"));

    if (!target) {
        throw new WatcherValidationError(`no notification target with id ${raw}; run: tools monitor targets`);
    }

    return target;
}

export function printTargets(targets: NotifyTarget[]): void {
    renderCliHeader("Notification library", `${targets.length} target${targets.length === 1 ? "" : "s"}`);
    const table = createBoxTable(["ID", "STATE", "NAME", "CHANNEL", "SETTINGS", "USED BY"]);

    for (const target of targets) {
        table.push([
            pc.white(String(target.id)),
            formatDotStatus(target.enabled ? "ok" : "dim", target.enabled ? "on" : "off"),
            pc.white(truncateDisplay(target.name, 28)),
            target.channel,
            truncateDisplay(describeTarget(target), 48),
            `${target.watcherCount} watcher${target.watcherCount === 1 ? "" : "s"}`,
        ]);
    }

    out.println(table.toString());
    renderCliSection("Next");
    out.println(
        `  ${suggestCommand("tools monitor targets", { replaceCommand: ["add", "--channel", "webhook", "--name", "Slack ops", "--url", "https://hooks…"] })}`
    );
    out.println(
        `  ${suggestCommand("tools monitor", { replaceCommand: ["edit", "<watcherId>", "--targets", "1,2"] })}`
    );
}

function channelFlags(command: Command): Command {
    return command
        .option("--sound <name>", "system: notification sound")
        .option("--title <text>", "system: notification title")
        .option("--ignore-dnd", "system: bypass Do Not Disturb")
        .option("--no-ignore-dnd", "system: respect Do Not Disturb")
        .option("--voice <id>", "say: voice id (see: tools monitor notify voices)")
        .option("--provider <name>", "say: macos, xai, openai")
        .option("--bot-token <token>", "telegram: bot token")
        .option("--chat-id <id>", "telegram: chat id")
        .option("--url <url>", "webhook: POST target")
        .option("--json", "Emit JSON");
}

export function registerTargetCommands(program: Command): void {
    const targets = program
        .command("targets")
        .description("Notification library: named destinations watchers can subscribe to");

    targets
        .command("list", { isDefault: true })
        .alias("ls")
        .description("List notification targets")
        .option("--json", "Emit JSON")
        .action(async (opts: { json?: boolean }) => {
            const list = await withMonitor((monitor) => monitor.listTargets());

            if (opts.json) {
                out.result({ targets: list });

                return;
            }

            if (list.length === 0) {
                out.log.info("The notification library is empty. Watchers use the monitor defaults until you add one.");
                out.println(
                    suggestCommand("tools monitor targets", {
                        replaceCommand: ["add", "--channel", "say", "--name", "Samantha", "--voice", "Samantha"],
                    })
                );

                return;
            }

            printTargets(list);
        });

    channelFlags(
        targets
            .command("add")
            .description("Add a named target (a webhook URL, a voice, a banner style, a Telegram chat)")
            .requiredOption("-n, --name <name>", "Display name")
            .option("-c, --channel [channel]", `One of ${NOTIFY_CHANNELS.join(", ")}`)
            .option("--disabled", "Create the target paused")
    ).action(async (flags: TargetFlags & { disabled?: boolean }) => {
        if (!isNotifyChannel(flags.channel)) {
            out.println(suggestEnumFlag("tools monitor targets add", "--channel", [...NOTIFY_CHANNELS]));
            process.exitCode = 1;

            return;
        }

        const input = parseNotifyTargetInput({
            name: flags.name,
            channel: flags.channel,
            config: configFromFlags(flags),
            enabled: !flags.disabled,
        });
        const target = await withMonitor((monitor) => monitor.createTarget(input));

        if (flags.json) {
            out.result({ target });

            return;
        }

        out.log.success(`Added target #${target.id} "${target.name}" (${target.channel}: ${describeTarget(target)})`);
    });

    channelFlags(
        targets
            .command("edit")
            .description("Change a target's name, fields or state")
            .argument("<id>", "Target id")
            .option("-n, --name <name>", "New display name")
            .option("--enable", "Resume the target")
            .option("--disable", "Pause the target")
    ).action(async (id: string, flags: TargetFlags & { enable?: boolean; disable?: boolean }) => {
        const target = await withMonitor(async (monitor) => {
            const current = await requireTarget(monitor, id);
            const config = configFromFlags(flags);
            const patch = parseNotifyTargetPatch(
                {
                    name: flags.name,
                    config: Object.keys(config).length > 0 ? { ...current.config, ...config } : undefined,
                    enabled: flags.enable ? true : flags.disable ? false : undefined,
                },
                current.channel
            );

            return monitor.updateTarget(current.id, patch);
        });

        if (flags.json) {
            out.result({ target });

            return;
        }

        out.log.success(`Updated target #${id} "${target?.name ?? ""}"`);
    });

    targets
        .command("rm")
        .alias("remove")
        .description("Delete a target (watchers subscribed to it fall back to the defaults)")
        .argument("<id>", "Target id")
        .action(async (id: string) => {
            const name = await withMonitor(async (monitor) => {
                const target = await requireTarget(monitor, id);
                await monitor.deleteTarget(target.id);

                return target.name;
            });
            out.log.success(`Deleted target #${id} "${name}"`);
        });

    targets
        .command("test")
        .description("Send a demo notification through one target (even a paused one)")
        .argument("<id>", "Target id")
        .action(async (id: string) => {
            const target = await withMonitor(async (monitor) => {
                const current = await requireTarget(monitor, id);

                return monitor.testTarget(current.id);
            });
            out.log.success(`Demo sent through #${id} "${target?.name ?? ""}" (${target?.channel ?? ""})`);
        });
}
