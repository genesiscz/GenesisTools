import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { nativeInboxState } from "@genesiscz/utils/macos/native-inbox";
import type { Command } from "commander";
import pc from "picocolors";
import { messageNote } from "../lib/inbox-guidance";
import { sendInboxMessage } from "../lib/message";
import { collect } from "./options";

export function registerMessageCommand(program: Command): void {
    program
        .command("message [text...]")
        .description("Send the user a message, optionally with screenshots, to the GenesisTools widget inbox")
        .option("--image <path>", "a PNG/JPEG/WebP screenshot to attach (repeatable)", collect, [])
        .option("--title <title>", "card title; defaults to the first line of the text")
        .option("--file <path>", "read the message text (markdown) from a file")
        .option("--agent <label>", "subagent attribution label")
        .option("--session <id>", "override the session id (only outside Claude, Codex or Grok)")
        .option("--project-path <path>", "source worktree directory; relative --image and --file paths resolve here")
        .option("--json", "print the receipt as JSON")
        .addHelpText(
            "after",
            `\nExamples:\n  ${toolCommand("question message", "Build is green, the hub after the fix:", "--image", "screenshots/hub-after.png")}\n  ${toolCommand("question message", "--title", "Blocked", "--file", "notes.md")}\n`
        )
        .action(
            async (
                words: string[],
                o: {
                    image: string[];
                    title?: string;
                    file?: string;
                    agent?: string;
                    session?: string;
                    projectPath?: string;
                    json?: boolean;
                }
            ) => {
                // A missing --file or a refused image is one red line, and the exit is explicit: a sink may already
                // hold the event loop open (see the exit below).
                const fail = (error: unknown): never => {
                    out.error(pc.red(error instanceof Error ? error.message : String(error)));
                    process.exit(1);
                };
                let text = "";

                try {
                    // Resolved like the images, so `--project-path` names one folder for both.
                    text = o.file
                        ? readFileSync(resolve(o.projectPath ?? process.cwd(), o.file), "utf8")
                        : words.join(" ");
                } catch (error) {
                    fail(error);
                }

                if (!text.trim() && o.image.length === 0) {
                    out.error(pc.red("Give the message text, --file, or at least one --image."));
                    process.exitCode = 1;
                    return;
                }

                const res = await sendInboxMessage({
                    text,
                    title: o.title,
                    images: o.image,
                    agentLabel: o.agent,
                    sessionHint: o.session,
                    projectPath: o.projectPath,
                    source: "cli",
                }).catch(fail);
                const note = messageNote(nativeInboxState());

                if (o.json) {
                    out.result({ ...res, note });
                } else {
                    out.print(`sent ${res.id} to session ${res.context.sessionId} (${res.context.agent})\n`);
                    out.printlnErr(pc.yellow(note));
                }

                // One-shot command: a sink (for example a Telegram client) can leave a handle open; see record.ts.
                process.exit(0);
            }
        );
}
