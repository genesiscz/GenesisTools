import {
    loadTelegramConfig,
    notConfiguredMessage,
    saveTelegramConfig,
    withTelegramConfigLock,
} from "@app/telegram-bot/lib/config";
import { out } from "@genesiscz/utils/logger";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";
import type { Command } from "commander";

async function editProjects(
    edit: (projects: NonNullable<TelegramBotConfig["decisions"]>["projects"]) => void
): Promise<TelegramBotConfig> {
    return withTelegramConfigLock(async () => {
        const config = await loadTelegramConfig();

        if (!config) {
            throw new Error(notConfiguredMessage());
        }

        const projects = { ...(config.decisions?.projects ?? {}) };
        edit(projects);
        const next: TelegramBotConfig = { ...config, decisions: { ...config.decisions, projects } };
        await saveTelegramConfig(next);
        return next;
    });
}

/**
 * `tools telegram-bot decisions`: which projects post their ❓ DECISIONs to Telegram with one button per letter.
 * Off for every project until enabled; the decision text is a second opt-in, because Telegram keeps what it is sent.
 */
export function registerDecisionsCommand(program: Command): void {
    const decisions = program
        .command("decisions")
        .description("Post the decisions of chosen projects to Telegram, with one answer button per option letter");

    decisions
        .command("list")
        .description("The projects that post their decisions, and whether the text goes too")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const config = await loadTelegramConfig();
            const projects = config?.decisions?.projects ?? {};

            if (opts.json) {
                out.result({ chat: config ? (config.chats.decisions ?? config.chats.commands) : null, projects });
                return;
            }

            const names = Object.keys(projects).sort();
            out.println(names.length === 0 ? "No project posts its decisions to Telegram." : "");
            for (const name of names) {
                out.println(`${name}  ${projects[name].text ? "letters and text" : "letters only"}`);
            }
        });

    decisions
        .command("enable <project>")
        .description("Post this project's decisions (the repository folder name) to the decisions chat")
        .option("--text", "also send the prompt and the option texts (Telegram stores them)")
        .action(async (project: string, opts: { text?: boolean }) => {
            await editProjects((projects) => {
                projects[project] = { text: opts.text === true };
            });
            out.println(`${project}: decisions post to Telegram (${opts.text ? "letters and text" : "letters only"}).`);
        });

    decisions
        .command("disable <project>")
        .description("Stop posting this project's decisions")
        .action(async (project: string) => {
            await editProjects((projects) => {
                delete projects[project];
            });
            out.println(`${project}: decisions no longer post to Telegram.`);
        });

    decisions
        .command("chat <chatId>")
        .description("Send decisions to another chat than the commands chat (the bot also takes presses from it)")
        .action(async (chatId: string) => {
            const id = Number(chatId);

            if (!Number.isSafeInteger(id)) {
                throw new Error(`not a chat id: ${chatId}`);
            }

            await withTelegramConfigLock(async () => {
                const config = await loadTelegramConfig();

                if (!config) {
                    throw new Error(notConfiguredMessage());
                }

                await saveTelegramConfig({ ...config, chats: { ...config.chats, decisions: id } });
            });
            out.println(`Decisions go to chat ${id}. Restart the bot so it takes presses from it.`);
        });
}
