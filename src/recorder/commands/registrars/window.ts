import { resolveRecording } from "@app/recorder/lib/library";
import { hostCloseEditor } from "@app/recorder/lib/service-client";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    const windowCommand = program
        .command("window")
        .description(
            `The recorder's editor windows: \`edit\` opens one, \`opened\` lists them, \`window close\` closes one`
        );

    windowCommand
        .command("close")
        .description(
            "Close a recording's editor window, as its close button does; refused while the window has a drag not saved yet or an export running"
        )
        .argument(
            "[recording]",
            "a library id, `last`, `open` (the one in front), a recording folder, a movie or an edit.json"
        )
        .option(
            "--window <number>",
            `the window number ${toolCommand("recorder opened --json")} lists, instead of a recording`
        )
        .option("--json", "print the answer as JSON")
        .action(async (given: string | undefined, flags: { window?: string; json?: boolean }) => {
            try {
                if (given === undefined && flags.window === undefined) {
                    throw new Error(
                        `name the recording, or --window <number>; ${toolCommand("recorder opened")} lists the open ones`
                    );
                }

                if (flags.window !== undefined && !/^\d+$/.test(flags.window)) {
                    throw new Error(`--window takes a window number, not "${flags.window}"`);
                }

                const answer = await hostCloseEditor(
                    flags.window !== undefined
                        ? { window: Number(flags.window) }
                        : { path: resolveRecording(given ?? "") }
                );

                if (flags.json) {
                    out.result(answer);
                    return;
                }

                out.println(
                    answer.closed ? `Closed editor window ${answer.window ?? ""}`.trim() : "No editor window shows it."
                );
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
