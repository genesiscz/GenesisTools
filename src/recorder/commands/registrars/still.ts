import { resolve } from "node:path";
import { parseTime } from "@app/recorder/commands/registrars/parse";
import { ensureRecorderPart } from "@app/recorder/lib/library";
import { Movie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("still")
        .description(
            "One frame on a PNG: the edit as it exports at an OUTPUT time, or with --source the recording as recorded at a SOURCE time"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .argument("[at]", "the time in seconds or m:ss (default 0)")
        .option("--source", "at is SOURCE seconds of the recording as recorded (no effects)")
        .option(
            "--full",
            "render at the export's size (the source's own pixels when the export keeps them), not 1080 tall"
        )
        .option("--out <png>", "where the picture goes (default a temporary file)")
        .action(
            async (
                value: string,
                at: string | undefined,
                flags: { source?: boolean; full?: boolean; out?: string }
            ) => {
                try {
                    await ensureRecorderPart((line) => out.printlnErr(line));
                    const answer = await new Movie(value).still(
                        at === undefined ? 0 : parseTime(at, "at"),
                        flags.out === undefined ? undefined : resolve(flags.out),
                        flags.full,
                        flags.source
                    );
                    out.result(answer);
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
