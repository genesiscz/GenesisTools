import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";

export function registerContactsCommand(program: Command): void {
    program
        .command("contacts")
        .description("List and manage watched contacts")
        .action(async () => {
            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data) {
                p.log.error("Not configured. Run: tools telegram configure");
                return;
            }

            if (data.contacts.length === 0) {
                p.log.info("No contacts configured. Run: tools telegram configure");
                return;
            }

            p.intro(pc.bgMagenta(pc.white(" telegram contacts ")));

            for (const c of data.contacts) {
                p.log.info(
                    `${pc.bold(c.displayName)} ${c.username ? pc.dim(`@${c.username}`) : ""}\n` +
                        `  Actions: [${c.actions.join(", ")}]` +
                        (c.askSystemPrompt ? `\n  Prompt: "${c.askSystemPrompt}"` : ""),
                );
            }

            const action = await p.select({
                message: "What would you like to do?",
                options: [
                    { value: "done" as const, label: "Done" },
                    { value: "remove" as const, label: "Remove a contact" },
                ],
            });

            if (p.isCancel(action) || action === "done") {
                p.outro("Done.");
                return;
            }

            if (action === "remove") {
                const toRemove = await p.select({
                    message: "Remove which contact?",
                    options: data.contacts.map((c) => ({
                        value: c.userId,
                        label: `${c.displayName} ${c.username ? `(@${c.username})` : ""}`,
                    })),
                });

                if (p.isCancel(toRemove)) {
                    return;
                }

                data.contacts = data.contacts.filter((c) => c.userId !== toRemove);
                await config.save(data);
                p.log.success("Contact removed.");
            }

            p.outro("Done.");
        });
}
