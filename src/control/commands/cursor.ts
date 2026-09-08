import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { type ClickSoftwareCursorOptions, clickSoftwareCursor, loadCursor, moveSoftwareCursor } from "../lib/cursor";

const BUTTONS = ["left", "right", "middle"] as const;

interface CursorMoveOptions {
    app: string;
    snapshot: string;
    coords: string;
    name: string;
}

interface CursorShowOptions {
    name: string;
}

interface CursorClickOptions {
    name: string;
    snapshot?: string;
    button?: string | boolean;
    double?: boolean;
}

export function registerCursorCommands(program: Command): void {
    const cursor = program
        .command("cursor")
        .description("Named software cursors for window-addressed macOS events; never moves the hardware pointer");

    cursor
        .command("move")
        .description("Move a named software cursor inside the exact app window from a fresh snapshot")
        .requiredOption("--app <name>", "same app instance as the snapshot")
        .requiredOption("--snapshot <token>", "opaque token returned by see")
        .requiredOption("--coords <x,y>", "global screen point")
        .option("--name <name>", "software cursor name", "default")
        .action((options: CursorMoveOptions) => {
            const result = moveSoftwareCursor(options);
            out.result(result);
            process.exitCode = result.ok ? 0 : 1;
        });

    cursor
        .command("show")
        .description("Show saved software cursor state without touching the app or pointer")
        .option("--name <name>", "software cursor name", "default")
        .action((options: CursorShowOptions) => {
            const saved = loadCursor(options.name);
            if (!saved) {
                const result = { ok: false, error: `software cursor ${options.name} does not exist; move it first` };
                out.result(result);
                process.exitCode = 1;
                return;
            }

            out.result(saved);
            process.exitCode = 0;
        });

    cursor
        .command("click")
        .description(
            "Click at a saved software cursor through its exact app window without moving the hardware pointer"
        )
        .option("--name <name>", "software cursor name", "default")
        .option("--snapshot <token>", "fresh token for the same saved app instance and window")
        .option("--button [name]", `one of: ${BUTTONS.join(", ")}`)
        .option("--double", "dispatch a double-click")
        .action((options: CursorClickOptions) => {
            if (
                options.button !== undefined &&
                (typeof options.button !== "string" || !BUTTONS.some((button) => button === options.button))
            ) {
                logger.error(suggestEnumFlag("tools control cursor click", "--button", BUTTONS));
                process.exitCode = 1;
                return;
            }

            const clickOptions: ClickSoftwareCursorOptions = {
                name: options.name,
                snapshot: options.snapshot,
                double: options.double,
            };
            if (typeof options.button === "string") {
                clickOptions.button = options.button as ClickSoftwareCursorOptions["button"];
            }

            const result = clickSoftwareCursor(clickOptions);
            out.result(result);
            process.exitCode = result.ok ? 0 : 1;
        });
}
