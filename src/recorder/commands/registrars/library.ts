import { ensureRecorderPart, openLibraryWindow } from "@app/recorder/lib/library";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("library")
        .description("Open the recordings library window: double-click a recording to edit it")
        .option("--no-focus", "open it behind the front window without activating the app")
        .action(async (flags: { focus?: boolean }) => {
            await ensureRecorderPart((line) => out.printlnErr(line));
            openLibraryWindow({ focus: flags.focus !== false });
        });
}
