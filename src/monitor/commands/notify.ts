import {
    CHANNEL_NAMES,
    getNotifySettings,
    type NotifySettings,
    type NotifySettingsPatch,
    sendTestNotification,
    updateNotifySettings,
} from "@app/monitor/lib/notify-settings";
import { listSayVoices } from "@app/monitor/lib/say-voices";
import { suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { ChannelName } from "@genesiscz/utils/notifications";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

interface SetOptions {
    enable?: boolean;
    disable?: boolean;
    reset?: boolean;
    sound?: string;
    title?: string;
    voice?: string;
    provider?: string;
    url?: string;
    botToken?: string;
    chatId?: string;
    ignoreDnd?: boolean;
    onDegraded?: boolean;
    onRecover?: boolean;
    json?: boolean;
}

function describeChannel(view: NotifySettings["channels"][number]): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(view.resolved)) {
        if (key === "enabled") {
            continue;
        }

        parts.push(`${key}=${typeof value === "string" ? value : String(value)}`);
    }

    return parts.join("  ");
}

function printSettings(settings: NotifySettings): void {
    renderCliHeader("Monitor notifications", "app overrides on top of `tools notify config`");
    const table = createBoxTable(["CHANNEL", "STATE", "SETTINGS", "OVERRIDES"]);

    for (const view of settings.channels) {
        const enabled = view.resolved.enabled === true;
        table.push([
            pc.white(view.name),
            formatDotStatus(enabled ? "ok" : "dim", enabled ? "on" : "off"),
            describeChannel(view),
            view.overridden.length > 0 ? view.overridden.join(", ") : pc.dim("global"),
        ]);
    }

    out.println(table.toString());
    renderCliSection("Events");
    out.println(`  degraded → ${settings.meta.onDegraded ? pc.green("notify") : pc.dim("muted")}`);
    out.println(`  recovered → ${settings.meta.onRecover ? pc.green("notify") : pc.dim("muted")}`);
    out.println(`  down → ${pc.green("always")}`);
    renderCliSection("Next");
    out.println(
        `  ${suggestCommand("tools monitor notify", { replaceCommand: ["set", "say", "--enable", "--voice", "Samantha"] })}`
    );
    out.println(`  ${suggestCommand("tools monitor notify", { replaceCommand: ["test"] })}`);
}

function buildPatch(channel: ChannelName, opts: SetOptions): NotifySettingsPatch {
    const patch: NotifySettingsPatch = {};

    if (opts.onDegraded !== undefined || opts.onRecover !== undefined) {
        patch.meta = {};

        if (opts.onDegraded !== undefined) {
            patch.meta.onDegraded = opts.onDegraded;
        }

        if (opts.onRecover !== undefined) {
            patch.meta.onRecover = opts.onRecover;
        }
    }

    if (opts.reset) {
        patch.channels = { [channel]: null };

        return patch;
    }

    const override: Record<string, unknown> = {};

    if (opts.enable) {
        override.enabled = true;
    }

    if (opts.disable) {
        override.enabled = false;
    }

    const fields: Array<[keyof SetOptions, string]> = [
        ["sound", "sound"],
        ["title", "title"],
        ["voice", "voice"],
        ["provider", "provider"],
        ["url", "url"],
        ["botToken", "botToken"],
        ["chatId", "chatId"],
    ];

    for (const [option, key] of fields) {
        if (opts[option] !== undefined) {
            override[key] = opts[option];
        }
    }

    if (opts.ignoreDnd !== undefined) {
        override.ignoreDnD = opts.ignoreDnd;
    }

    if (Object.keys(override).length > 0) {
        patch.channels = { [channel]: override as never };
    }

    return patch;
}

export function registerNotifyCommands(program: Command): void {
    const notify = program.command("notify").description("Configure how monitor state changes are announced");

    notify
        .command("show", { isDefault: true })
        .description("Show the effective notification channels for monitor")
        .option("--json", "Emit JSON")
        .action(async (opts: { json?: boolean }) => {
            const settings = await getNotifySettings();

            if (opts.json) {
                out.result({ settings });

                return;
            }

            printSettings(settings);
        });

    notify
        .command("set")
        .description("Override a channel for monitor (global defaults come from `tools notify config`)")
        .argument("[channel]", `One of ${CHANNEL_NAMES.join(", ")}`)
        .option("--enable", "Turn the channel on for monitor")
        .option("--disable", "Turn the channel off for monitor")
        .option("--reset", "Drop every monitor override for this channel")
        .option("--sound <name>", "system: notification sound")
        .option("--title <text>", "system: notification title")
        .option("--ignore-dnd", "system: bypass Do Not Disturb")
        .option("--no-ignore-dnd", "system: respect Do Not Disturb")
        .option("--voice <name>", "say: voice id (see: tools monitor notify voices)")
        .option("--provider <name>", "say: TTS backend for that voice: macos, xai, openai")
        .option("--url <url>", "webhook: POST target")
        .option("--bot-token <token>", "telegram: bot token")
        .option("--chat-id <id>", "telegram: chat id")
        .option("--on-degraded", "Notify when a watcher turns degraded")
        .option("--no-on-degraded", "Only notify on down and recovery")
        .option("--on-recover", "Notify when a watcher recovers")
        .option("--no-on-recover", "Stay quiet on recovery")
        .option("--json", "Emit the resulting settings as JSON")
        .action(async (channel: string | undefined, opts: SetOptions) => {
            const metaOnly = channel === undefined && (opts.onDegraded !== undefined || opts.onRecover !== undefined);

            if (!metaOnly && (!channel || !CHANNEL_NAMES.includes(channel as ChannelName))) {
                out.println(suggestEnumFlag("tools monitor notify set", "<channel>", [...CHANNEL_NAMES]));
                process.exitCode = 1;

                return;
            }

            const patch = buildPatch((channel ?? "system") as ChannelName, opts);

            if (!patch.meta && !patch.channels) {
                out.log.warn("Nothing to change; pass --enable, --disable, --reset or a field flag.");
                process.exitCode = 1;

                return;
            }

            const settings = await updateNotifySettings(patch);

            if (opts.json) {
                out.result({ settings });

                return;
            }

            printSettings(settings);
        });

    notify
        .command("voices")
        .description("List the voices `tools say` can use right now, grouped by provider")
        .option("--json", "Emit JSON")
        .action(async (opts: { json?: boolean }) => {
            const providers = await listSayVoices({ fresh: true });

            if (opts.json) {
                out.result({ providers });

                return;
            }

            for (const provider of providers) {
                renderCliSection(`${provider.label} (--provider ${provider.id}) · ${provider.voices.length} voices`);
                const table = createBoxTable(["VOICE", "NAME", "LOCALE"]);

                for (const voice of provider.voices) {
                    table.push([pc.white(voice.id), voice.name, voice.locale ?? ""]);
                }

                out.println(table.toString());
            }

            out.println(
                `  ${suggestCommand("tools monitor notify", { replaceCommand: ["set", "say", "--enable", "--provider", "<id>", "--voice", "<voice>"] })}`
            );
        });

    notify
        .command("test")
        .description("Send a test notification through every enabled channel")
        .option("--json", "Emit JSON")
        .action(async (opts: { json?: boolean }) => {
            const result = await sendTestNotification();

            if (opts.json) {
                out.result(result);

                return;
            }

            out.log.success(`Test notification sent via: ${result.channels.join(", ") || "no enabled channel"}`);
        });
}
