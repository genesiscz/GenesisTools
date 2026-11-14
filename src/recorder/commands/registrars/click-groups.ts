import { openProject } from "@app/recorder/lib/edit";
import { clickGroupsOf } from "@app/recorder/lib/moments";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("click-groups")
        .description(
            "The recorded clicks in groups (as autoZoom groups them), each with its count, source seconds and where it plays"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--gap <seconds>", "a click under this many seconds after the one before joins its group (3)")
        .action(async (value: string, flags: { gap?: string }) => {
            try {
                const gapSeconds = flags.gap === undefined ? undefined : Number(flags.gap);

                if (gapSeconds !== undefined && !(gapSeconds >= 0.1 && gapSeconds <= 60)) {
                    throw new Error(`--gap takes 0.1 to 60 seconds, not "${flags.gap}"`);
                }

                const groups = clickGroupsOf((await openProject(value)).project, { gapSeconds });

                for (const group of groups) {
                    const plays = group.plays ? `plays ${group.plays.from}-${group.plays.to} s` : "cut, never plays";
                    out.printlnErr(
                        `${group.count} click${group.count === 1 ? "" : "s"} at ${group.from}-${group.to} s (${plays}${group.cut && group.plays ? `, ${group.cut} cut` : ""})`
                    );
                }

                if (!groups.length) {
                    out.printlnErr("the cursor track has no clicks");
                }

                out.result(groups);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
