import { resolveRecording } from "@app/recorder/lib/library";
import { revealRecording } from "@app/recorder/lib/quick-actions";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("reveal")
        .description("Show a recording's folder in Finder; --meeting shows its meeting's record instead")
        .argument("<recording>", "a library id, `last` or a recording folder")
        .option("--meeting", "the meeting.json of a meeting's screen recording")
        .action(async (value: string, flags: { meeting?: boolean }) => {
            try {
                out.result(await revealRecording(resolveRecording(value), { meeting: flags.meeting }));
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
