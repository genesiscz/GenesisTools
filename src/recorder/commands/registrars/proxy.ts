import { readFileSync } from "node:fs";
import { parseTime } from "@app/recorder/commands/registrars/parse";
import {
    keepingSwitchStep,
    keptPlan,
    prepareFramesMovie,
    restoreDisplayPlan,
    stepDisplaySwitch,
} from "@app/recorder/lib/frames-movie";
import { resolveRecording } from "@app/recorder/lib/library";
import {
    type DisplayRange,
    PROXY_DISPLAY_POLICIES,
    type ProxyDisplay,
    parseDisplayPlan,
} from "@app/recorder/lib/proxy";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { timeToUs } from "@genesiscz/utils/recording-editor/plan";
import type { Command } from "commander";

/** `--display`: `most-change` or a display id. */
function parseProxyDisplay(raw: string): ProxyDisplay {
    if ((PROXY_DISPLAY_POLICIES as readonly string[]).includes(raw)) {
        return "most-change";
    }

    const id = Number(raw);

    if (!Number.isInteger(id) || id < 0) {
        throw new Error(`--display takes ${PROXY_DISPLAY_POLICIES.join(", ")} or a display id (got "${raw}")`);
    }

    return id;
}

/** `--switch 10:00-12:30=4`: a range on the recording's clock and the display it shows. */
function parseDisplaySwitch(raw: string): DisplayRange {
    const match = /^([^-=]+)-([^=]+)=(\d+)$/.exec(raw.trim());

    if (!match) {
        throw new Error(`--switch takes <from>-<to>=<display>, e.g. 10:00-12:30=4 (got "${raw}")`);
    }

    const fromUs = timeToUs(parseTime(match[1], "--switch"));
    const toUs = timeToUs(parseTime(match[2], "--switch"));

    if (toUs <= fromUs) {
        throw new Error(`--switch ${raw}: the end must come after the start`);
    }

    return { fromUs, toUs, displayId: Number(match[3]) };
}

export function register(program: Command): void {
    program
        .command("proxy")
        .description(
            "Make proxy.mp4 for a frames-only recording (frames at their times, audio pieces mixed in), so the editor opens it"
        )
        .argument("<recording>", "a library id, `last`, a meeting id or a recording folder")
        .option(
            "--display <display>",
            "most-change (default: per window the display that changed most) or a display id"
        )
        .option("--window <seconds>", "the window most-change picks a display for", "10")
        .option(
            "--switch <from-to=display...>",
            "show this display in this range whatever the policy picks, e.g. 10:00-12:30=4 (repeatable)"
        )
        .option(
            "--keep-plan",
            "keep the display plan of the last proxy (proxy.json) and lay the --switch ranges over it, as the editor does"
        )
        .option(
            "--plan <file>",
            "make it with exactly the display plan in this file (a copy of an earlier proxy.json); not with --display, --switch or --keep-plan"
        )
        .option(
            "--undo-switch",
            "take the last display switch back: the movie is made again with the plan from before it (proxy.undo.json), as the editor's ⌘Z does"
        )
        .option("--redo-switch", "make the last undone display switch again")
        .action(
            async (
                value: string,
                flags: {
                    display?: string;
                    window?: string;
                    switch?: string[];
                    keepPlan?: boolean;
                    plan?: string;
                    undoSwitch?: boolean;
                    redoSwitch?: boolean;
                }
            ) => {
                try {
                    const folder = resolveRecording(value);

                    if (flags.undoSwitch || flags.redoSwitch) {
                        if (
                            (flags.undoSwitch && flags.redoSwitch) ||
                            flags.plan ||
                            flags.display !== undefined ||
                            flags.switch?.length ||
                            flags.keepPlan
                        ) {
                            throw new Error("--undo-switch and --redo-switch take only the recording");
                        }

                        out.result(await stepDisplaySwitch(folder, flags.undoSwitch ? "undo" : "redo"));
                        return;
                    }

                    if (flags.plan) {
                        if (flags.display !== undefined || flags.switch?.length || flags.keepPlan) {
                            throw new Error(
                                "--plan is the whole display plan; give it without --display, --switch or --keep-plan"
                            );
                        }

                        const plan = parseDisplayPlan(
                            SafeJSON.parse(readFileSync(flags.plan, "utf8"), { strict: true })
                        );
                        out.result(await restoreDisplayPlan(folder, plan));
                        return;
                    }

                    const display = flags.display === undefined ? undefined : parseProxyDisplay(flags.display);
                    const switches = (flags.switch ?? []).map(parseDisplaySwitch);
                    const make = () =>
                        prepareFramesMovie(folder, {
                            ...(display !== undefined ? { display } : {}),
                            windowSec: Number(flags.window ?? 10),
                            ...(flags.keepPlan ? keptPlan(folder, switches) : { overrides: switches }),
                        });
                    // A switch is one step that --undo-switch, the REPL and the editor take back.
                    out.result(switches.length > 0 ? await keepingSwitchStep(folder, make) : await make());
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
