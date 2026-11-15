import { parseTime, resolveEnumFlag } from "@app/recorder/commands/registrars/parse";
import { prepareFramesMovie } from "@app/recorder/lib/frames-movie";
import {
    EDITOR_TABS,
    ensureRecorderPart,
    listLibrary,
    movieOf,
    openLibraryWindow,
    resolveRecording,
} from "@app/recorder/lib/library";
import { hostOpenEditor } from "@app/recorder/lib/service-client";
import { isInteractive } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { timeToUs } from "@genesiscz/utils/recording-editor/plan";
import type { Command } from "commander";

/**
 * The recording `tools recorder edit` opens when none is named: a list of the newest ones in a terminal, the library
 * window otherwise (undefined then, since the window opens the pick itself).
 */
async function pickRecording(): Promise<string | undefined> {
    const rows = listLibrary({ limit: 20 });

    if (!isInteractive() || rows.length === 0) {
        await ensureRecorderPart((line) => out.printlnErr(line));
        openLibraryWindow();
        out.printlnErr("Opened the recordings library: double-click a recording to edit it.");
        return undefined;
    }

    const picked = await p.select({
        message: "Which recording?",
        options: rows.map((row) => ({
            value: row.folder,
            label: row.title,
            hint: `${row.startedAt.slice(0, 16).replace("T", " ")}${row.edited ? " · edited" : ""}`,
        })),
        cancel: "back",
    });

    return p.isCancel(picked) ? undefined : rows.find((row) => row.folder === picked)?.folder;
}

export function register(program: Command): void {
    program
        .command("edit")
        .description("Open a recording or a movie in the recorder's editor window (no recording: pick one)")
        .argument("[recording]", "a library id, `last`, `open`, a recording folder, a movie or an edit.json")
        .option("--no-focus", "open it behind the front window without activating the app")
        .option("--at <time>", "put the playhead at this OUTPUT time (seconds or m:ss)")
        .option("--tab [name]", `open this inspector tab: ${EDITOR_TABS.join(", ")}`)
        .action(async (given: string | undefined, flags: { focus?: boolean; at?: string; tab?: string | boolean }) => {
            try {
                const value = given ?? (await pickRecording());

                if (!value) {
                    return;
                }

                const tab = await resolveEnumFlag({
                    flag: "--tab",
                    raw: flags.tab,
                    values: EDITOR_TABS,
                    subcommand: ["edit"],
                    message: "Which editor tab?",
                });

                if (tab === null) {
                    return;
                }

                const atSeconds =
                    flags.at === undefined ? undefined : timeToUs(parseTime(flags.at, "--at")) / 1_000_000;
                const path = resolveRecording(value);

                const lowerPath = path.toLowerCase();

                if (
                    !lowerPath.endsWith(".mp4") &&
                    !lowerPath.endsWith(".mov") &&
                    !lowerPath.endsWith(".json") &&
                    !movieOf(path)
                ) {
                    out.printlnErr("This recording has frames only; making proxy.mp4 for the editor…");
                    await prepareFramesMovie(path, {});
                }

                await ensureRecorderPart((line) => out.printlnErr(line));
                // What opened, so an agent needs no second call (`tools recorder opened`) to know it worked.
                out.result({ ...(await hostOpenEditor(path, { focus: flags.focus !== false, atSeconds, tab })), path });
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
