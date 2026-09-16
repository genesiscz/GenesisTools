#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { isInteractive, runTool, suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { GenesisAppRpcFailure, GenesisAppRpcOutcome } from "@genesiscz/utils/macos/genesis-app-rpc";
import type { NotificationAction, NotificationOptions } from "@genesiscz/utils/macos/notifications";
import {
    askNotification,
    authorizeNotifications,
    listNotifications,
    notificationStatus,
    openNotificationSettings,
    parseNotificationOptions,
    postNotification,
    readNotificationReply,
    removeNotifications,
} from "@genesiscz/utils/macos/notifications";
import type { ChannelConfigs } from "@genesiscz/utils/notifications";
import { dispatchNotification, notificationsConfig } from "@genesiscz/utils/notifications";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    truncateDisplay,
} from "@genesiscz/utils/table";
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
        out.error("notify config requires an interactive terminal.");
        out.info(suggestCommand("tools notify", { add: ["--title", "Test", "Hello"] }));
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
    .description("Send macOS notifications via GenesisTools.app")
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
    .option(
        "--payload <json>",
        'Full notification as JSON ("-" reads stdin). Reaches every field the flags cannot: actions, input fields, attachments, id. Prints the result as JSON.'
    )
    .option("--wait", "With --payload: block until the user answers, and print the reply")
    .option("--timeout <seconds>", "With --payload --wait: how long to wait", "300")
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
                payload?: string;
                wait?: boolean;
                timeout: string;
            }
        ) => {
            // One JSON door, the same shape the app's own --rpc takes, so anything the API can
            // express is reachable from the CLI without growing a flag per field.
            if (options.payload) {
                await sendPayload(options.payload, Boolean(options.wait), Number(options.timeout) * 1000);
                return;
            }

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

program
    .command("ask")
    .description("Ask a question in a notification and wait for the typed answer")
    .argument("<question>", "The question shown in the notification body")
    .option("-t, --title <title>", "Notification title", "GenesisTools asks")
    .option("-s, --subtitle <subtitle>", "Notification subtitle")
    .option("-g, --group <id>", "Group id, so repeated asks collapse instead of stacking")
    .option("--id <id>", "Stable notification id (generated when omitted); needed to read the reply later")
    .option("--placeholder <text>", "Hint shown inside the empty text field")
    .option("--button <label>", "Label on the send button", "Send")
    .option("--choice <id:label>", "Extra plain button instead of typing (repeatable)", collectChoice, [])
    .option("--timeout <seconds>", "How long to wait before giving up", "300")
    .option("--no-wait", "Post and print the id, do not block; read it later with `notify reply`")
    .option("--json", "Print the reply as JSON")
    .action(async (question: string, options: AskOptions) => {
        const actions: NotificationAction[] = [
            {
                id: "answer",
                title: "Answer",
                input: { buttonTitle: options.button, placeholder: options.placeholder },
            },
            ...options.choice.map((c) => ({ id: c.id, title: c.label })),
        ];

        const payload: NotificationOptions = {
            id: options.id,
            title: options.title,
            subtitle: options.subtitle,
            message: question,
            group: options.group,
            actions,
        };

        if (!options.wait) {
            const posted = await postNotification(payload);

            if (!posted.id) {
                out.error("Only the genesis-app backend can carry a reply; is GenesisTools.app built?");
                out.error(suggestCommand("tools macos permissions", { replaceCommand: ["build"] }));
                process.exitCode = 1;
                return;
            }

            if (options.json) {
                out.result({ id: posted.id, answered: false });
            } else {
                out.println(posted.id);
            }

            return;
        }

        const reply = await askNotification(payload, { timeoutMs: Number(options.timeout) * 1000 });

        if (!reply) {
            // Not an error: a question the user ignored is a normal outcome, and the exit code is
            // what a script branches on.
            if (options.json) {
                out.result({ answered: false });
            } else {
                out.log.warn(`No answer within ${options.timeout}s`);
            }

            process.exitCode = 1;
            return;
        }

        if (options.json) {
            out.result(reply);
            return;
        }

        out.println(reply.text ?? reply.actionId);
    });

program
    .command("reply")
    .description("Read the answer to a question asked earlier with `notify ask --no-wait`")
    .argument("<id>", "The notification id printed by `notify ask --no-wait`")
    .option("--consume", "Delete the answer as it is read, so it cannot be acted on twice")
    .option("--json", "Print the reply as JSON")
    .action(async (id: string, options: { consume?: boolean; json?: boolean }) => {
        const reply = await readNotificationReply(id, { consume: options.consume });

        if (!reply) {
            if (options.json) {
                out.result({ answered: false, id });
            } else {
                out.log.warn(`${id} has not been answered yet`);
            }

            process.exitCode = 1;
            return;
        }

        if (options.json) {
            out.result(reply);
            return;
        }

        out.println(reply.text ?? reply.actionId);
    });

program
    .command("status")
    .description("Show what macOS thinks of GenesisTools.app notifications")
    .option("--json", "Print the status as JSON")
    .action(async (options: { json?: boolean }) => {
        const outcome = await notificationStatus();

        if (!printRpcOutcome(outcome, options.json)) {
            return;
        }

        if (options.json) {
            out.result(outcome.result);
            return;
        }

        const status = outcome.result;
        const authKind =
            status.authorization === "authorized" ? "ok" : status.authorization === "denied" ? "err" : "warn";
        renderCliHeader("Notifications", status.bundleId);
        renderCliKeyRow("AUTH", formatDotStatus(authKind, status.authorization), 12);
        renderCliKeyRow("STYLE", status.alertStyle, 12);
        renderCliKeyRow(
            "TEMPORARY",
            status.temporary ? "yes — banners fade in ~5s; pick Persistent in System Settings" : "no",
            12
        );
        renderCliKeyRow("SOUND", status.soundSetting, 12);
        renderCliKeyRow("BUNDLE", truncateDisplay(status.bundlePath, 80), 12);

        if (status.temporary) {
            out.println();
            out.println(`  ${pc.dim("Next")} ${suggestCommand("tools notify", { replaceCommand: ["settings"] })}`);
        }

        if (status.authorization === "notDetermined" || status.authorization === "denied") {
            out.println();
            out.println(`  ${pc.dim("Next")} ${suggestCommand("tools notify", { replaceCommand: ["authorize"] })}`);
        }
    });

program
    .command("authorize")
    .description("Ask macOS for notification permission and wait for the answer")
    .option("--json", "Print the result as JSON")
    .action(async (options: { json?: boolean }) => {
        const outcome = await authorizeNotifications();

        if (!printRpcOutcome(outcome, options.json)) {
            return;
        }

        if (options.json) {
            out.result(outcome.result);
            return;
        }

        const granted = outcome.result.granted === true;
        out.println(granted ? "granted" : "not granted");

        if (typeof outcome.result.note === "string" && outcome.result.note.length > 0) {
            out.println(pc.dim(outcome.result.note));
        }
    });

program
    .command("settings")
    .description("Open System Settings > Notifications for GenesisTools.app")
    .option("--json", "Print the result as JSON")
    .action(async (options: { json?: boolean }) => {
        const outcome = await openNotificationSettings();

        if (!printRpcOutcome(outcome, options.json)) {
            return;
        }

        if (options.json) {
            out.result(outcome.result);
            return;
        }

        out.println(outcome.result.opened);
    });

program
    .command("list")
    .description("List notifications still in Notification Center from GenesisTools.app")
    .option("--json", "Print the list as JSON")
    .action(async (options: { json?: boolean }) => {
        const rows = await listNotifications();

        if (rows === null) {
            printAppUnavailable();
            return;
        }

        if (options.json) {
            out.result({ notifications: rows });
            return;
        }

        if (rows.length === 0) {
            out.println("No delivered GenesisTools.app notifications.");
            return;
        }

        const table = createBoxTable(["ID", "TITLE", "MESSAGE", "GROUP"]);

        for (const row of rows) {
            table.push([
                pc.white(truncateDisplay(row.id, 36)),
                truncateDisplay(row.title, 24),
                truncateDisplay(row.message, 40),
                truncateDisplay(row.group, 16),
            ]);
        }

        out.println(table.toString());
    });

program
    .command("remove")
    .description("Retract notifications posted by GenesisTools.app")
    .argument("[ids...]", "Notification ids to retract")
    .option("--group <id>", "Remove every notification in this group")
    .option("--all", "Remove every GenesisTools.app notification")
    .option("--json", "Print the result as JSON")
    .action(async (ids: string[], options: { group?: string; all?: boolean; json?: boolean }) => {
        if (!options.all && !options.group && ids.length === 0) {
            out.error("notify remove needs ids, --group, or --all");
            out.info(suggestCommand("tools notify", { replaceCommand: ["remove", "--all"] }));
            process.exitCode = 1;
            return;
        }

        const removed = await removeNotifications({
            ids: ids.length > 0 ? ids : undefined,
            group: options.group,
            all: options.all,
        });

        if (removed === null) {
            printAppUnavailable();
            return;
        }

        if (options.json) {
            out.result({ removed });
            return;
        }

        out.println(removed === "all" ? "removed all" : `removed ${removed.join(" ")}`);
    });

function printAppUnavailable(): void {
    out.error("GenesisTools.app is not installed, or routing is switched off.");
    out.info(suggestCommand("tools macos permissions", { replaceCommand: ["build"] }));
    process.exitCode = 1;
}

function printRpcFailure(error: GenesisAppRpcFailure): void {
    out.error(`${error.code}: ${error.message}`);

    if (error.code === "unavailable") {
        out.info(suggestCommand("tools macos permissions", { replaceCommand: ["build"] }));
    } else if (error.code === "not_determined" || error.code === "denied") {
        out.info(suggestCommand("tools notify", { replaceCommand: ["authorize"] }));
    }

    process.exitCode = 1;
}

function printRpcOutcome<T>(outcome: GenesisAppRpcOutcome<T>, json?: boolean): outcome is { ok: true; result: T } {
    if (outcome.ok) {
        return true;
    }

    if (json) {
        out.result(outcome);
    } else {
        printRpcFailure(outcome.error);
        return false;
    }

    process.exitCode = 1;
    return false;
}

/**
 * `tools notify --payload '<json>'` (or `--payload -` for stdin).
 *
 * The flags cover the common case; this covers everything else — action buttons, text-input
 * questions, attachments, a stable id — without the CLI growing a flag per field. The JSON is the
 * same `NotificationOptions` the library takes, which is the same shape the app's `--rpc` carries.
 */
async function sendPayload(source: string, wait: boolean, timeoutMs: number): Promise<void> {
    const raw = source === "-" ? await Bun.stdin.text() : source;
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(raw, { strict: true });
    } catch (error) {
        out.error(`--payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }

    const payload = parseNotificationOptions(parsed);

    if (!payload.ok) {
        out.error(payload.error);
        process.exitCode = 1;
        return;
    }

    if (!wait) {
        out.result(await postNotification(payload.value));
        return;
    }

    const reply = await askNotification(payload.value, { timeoutMs });
    out.result(reply ?? { answered: false });

    if (!reply) {
        process.exitCode = 1;
    }
}

interface AskChoice {
    id: string;
    label: string;
}

interface AskOptions {
    title: string;
    subtitle?: string;
    group?: string;
    id?: string;
    placeholder?: string;
    button: string;
    choice: AskChoice[];
    timeout: string;
    wait: boolean;
    json?: boolean;
}

/** `--choice deploy:Deploy now` → `{id: "deploy", label: "Deploy now"}`. A bare value is both. */
function collectChoice(value: string, previous: AskChoice[]): AskChoice[] {
    const separator = value.indexOf(":");
    const choice =
        separator === -1
            ? { id: value, label: value }
            : { id: value.slice(0, separator), label: value.slice(separator + 1) };

    return [...previous, choice];
}

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "notify" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        // Use exitCode rather than process.exit() so the finally block below
        // runs and closes the DarwinKit child. process.exit() terminates
        // synchronously and would skip finally — defeating the whole point.
        process.exitCode = 1;
    } finally {
        // sendViaDarwinKit() spawns a long-lived Swift child via the
        // module-level singleton in @app/utils/macos/darwinkit. Without
        // closeDarwinKit() here, the child's stdio pipes keep Node's event
        // loop alive forever — a single `tools notify` invocation leaks
        // both processes. Defense in depth alongside the SDK's unref() +
        // exit reaper.
        try {
            const { closeDarwinKit, hasDarwinKit } = await import("@genesiscz/utils/macos");
            if (hasDarwinKit()) {
                closeDarwinKit();
            }
        } catch (error) {
            // Cleanup is best-effort; log so a real failure (e.g. SDK API
            // change) is visible in debug output without breaking the CLI.
            logger.debug(`DarwinKit cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

// Guarded so importing this module (a test, `tools ts imports analyze`) does not run the CLI:
// unguarded, the import parsed an empty argv and cost 63 ms of commander work.
if (import.meta.main) {
    try {
        await main();
    } catch (err) {
        logger.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
