import { resolve } from "node:path";
import { parseTime } from "@app/recorder/commands/registrars/parse";
import { ensureRecorderPart } from "@app/recorder/lib/library";
import { Movie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("sheet")
        .description(
            "Several frames on one PNG grid, each labelled with its time: the edit as it exports (OUTPUT seconds) or, with --source, the recording as it was recorded (SOURCE seconds, the seconds ops take)"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--count <n>", "frames spread over the range (default 6, at most 48)")
        .option("--every <seconds>", "a frame every this many seconds over the range instead (a dense survey: 0.5)")
        .option("--from <time>", "the range's start in seconds or m:ss (default 0)")
        .option("--to <time>", "the range's end (default the end)")
        .option("--at <times>", "these times instead, comma-separated (2,5.5,0:12)")
        .option("--source", "times are SOURCE seconds of the recording as recorded (cut parts too, no effects)")
        .option("--columns <n>", "the grid's columns (default by the frames' shape, a near 16:9 sheet)")
        .option("--out <png>", "where the picture goes (default a temporary file)")
        .action(
            async (
                value: string,
                flags: {
                    count?: string;
                    every?: string;
                    from?: string;
                    to?: string;
                    at?: string;
                    source?: boolean;
                    columns?: string;
                    out?: string;
                }
            ) => {
                try {
                    await ensureRecorderPart((line) => out.printlnErr(line));
                    const answer = await new Movie(value).sheet({
                        count: flags.count === undefined ? undefined : Number(flags.count),
                        every: flags.every === undefined ? undefined : Number(flags.every),
                        from: flags.from === undefined ? undefined : parseTime(flags.from, "--from"),
                        to: flags.to === undefined ? undefined : parseTime(flags.to, "--to"),
                        at: flags.at?.split(",").map((time) => parseTime(time.trim(), "--at")),
                        source: flags.source,
                        columns: flags.columns === undefined ? undefined : Number(flags.columns),
                        out: flags.out === undefined ? undefined : resolve(flags.out),
                    });
                    out.result(answer);
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
