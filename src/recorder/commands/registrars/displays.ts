import { displayFramesFolder, readDisplayTimeline } from "@app/recorder/lib/display-ops";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

const { log } = logger.scoped("recorder");

const clock = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;

export function register(program: Command): void {
    program
        .command("displays")
        .description(
            `Which display a frames recording of several displays shows when: each display, the segments from start to end and the switch points, in source seconds. Change it with the ops switchDisplay, hideDisplay and moveDisplaySwitch in ${toolCommand("recorder apply")}`
        )
        .argument("<recording>", "a library id, `last`, a meeting id, a recording folder, a movie or an edit.json")
        .option("--json", "print as JSON (null when the recording has no display plan yet)")
        .action(async (value: string, flags: { json?: boolean }) => {
            try {
                const timeline = readDisplayTimeline(await displayFramesFolder(value, "list"));

                if (flags.json) {
                    out.result(timeline ?? null);
                    return;
                }

                if (!timeline) {
                    out.printlnErr(
                        `It has no display plan yet. Make its movie first: ${toolCommand("recorder proxy")} ${value}`
                    );
                    return;
                }

                for (const display of timeline.displays) {
                    out.println(
                        `display ${display.id}  ${display.name}: shown ${clock(display.shownSec)} in ${display.segments} segment(s), first frame at ${clock(display.firstSec)}`
                    );
                }

                out.println("");

                for (const segment of timeline.segments) {
                    out.println(
                        `${clock(segment.from)} to ${clock(segment.to)}  display ${segment.display}  ${segment.name}`
                    );
                }
            } catch (error) {
                log.debug({ error }, "recorder displays failed");
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
