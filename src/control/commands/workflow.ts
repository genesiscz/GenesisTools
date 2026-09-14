import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { runAx } from "../lib/runner";

const ACTIONS = [
    "get",
    "press",
    "click",
    "move",
    "drag",
    "set",
    "perform",
    "focus",
    "scroll",
    "type",
    "key",
    "select",
    "paste",
] as const;
const BUTTONS = ["left", "right", "middle"] as const;
const DIRECTIONS = ["up", "down", "left", "right"] as const;
const SELECTIONS = ["text", "cursor_before", "cursor_after"] as const;
const FORMATS = ["text", "md", "html"] as const;

interface WorkflowOptions {
    app: string;
    windowIndex?: string;
    windowId?: string;
    depth?: string;
    scope?: string | boolean;
    path?: string;
    snapshot?: string;
    element?: string;
    action?: string | boolean;
    value?: string;
    axAction?: string;
    direction?: string | boolean;
    text?: string;
    keys?: string;
    double?: boolean;
    coords?: string;
    background?: boolean;
    button?: string | boolean;
    to?: string;
    duration?: string;
    pages?: string;
    pixels?: string;
    range?: string;
    prefix?: string;
    suffix?: string;
    selection?: string | boolean;
    format?: string | boolean;
}

export function registerWorkflowCommands(program: Command): void {
    program
        .command("see")
        .description(
            "Inspect one window: indexed AX tree, PNG and a snapshot token valid for 120 seconds. Never activates the app. Multiple windows require --window-index or --window-id. Output is JSON."
        )
        .requiredOption("--app <name>", "running app name, bundle ID or PID")
        .option("--window-index <n>", "zero-based AX window index from a see ambiguity result")
        .option("--window-id <id>", "stable CG window ID from a previous see; alternative to --window-index")
        .option("--depth <n>", "tree depth, 1–50; refuses truncated trees", "20")
        .option("--scope [name]", "window (default) or chrome (omit web-area descendants for browser controls)")
        .option("--path <png>", "save screenshot here (default: unique temporary PNG)")
        .action((opts: WorkflowOptions) => {
            if (opts.scope !== undefined && !["window", "chrome"].includes(String(opts.scope))) {
                logger.error(suggestEnumFlag("tools control see", "--scope", ["window", "chrome"]));
                process.exitCode = 1;
                return;
            }
            const args = ["see", "--app", opts.app];
            if (typeof opts.scope === "string") {
                args.push("--scope", opts.scope);
            }

            for (const [flag, value] of [
                ["window-index", opts.windowIndex],
                ["window-id", opts.windowId],
                ["depth", opts.depth],
                ["path", opts.path],
            ]) {
                if (value !== undefined) {
                    args.push(`--${flag}`, value);
                }
            }

            const result = runAx(args, 30_000);
            out.result(result);
            process.exitCode = result.ok ? 0 : 1;
        });

    program
        .command("act")
        .description(
            "Act on an element from see after validating app instance, window, age and tree. Refuses stale refs; never retries or falls back. Output is JSON. Run see again after every action. Default click/type/key require the target window already focused; focus is explicit. click --background uses window-addressed delivery without moving the pointer."
        )
        .requiredOption("--app <name>", "same app instance as the snapshot")
        .requiredOption("--snapshot <token>", "opaque token returned by see")
        .option("--element <n>", "element index copied from that snapshot; alternative to click --coords")
        .option("--action [name]", `one of: ${ACTIONS.join(", ")}`)
        .option("--value <text>", "set: AXValue text, read back to verify; no keystrokes")
        .option("--ax-action <name>", "perform: exact action from the element's actions list")
        .option("--direction [name]", "scroll: direction up, down, left or right; page or pixel wheel mode")
        .option("--text <text>", "type/select/paste: text; type is single-line and limited to 256 UTF-16 units")
        .option(
            "--keys <combo>",
            "key: comma-separated modifiers cmd,ctrl,alt,shift plus a letter, digit, return, tab, escape, backspace or arrow"
        )
        .option("--double", "click: double-click the observed element")
        .option("--coords <x,y>", "click/move/drag/scroll: global screen point; alternative to --element")
        .option("--background", "click/move/drag/scroll: deliver without explicit activation or pointer movement")
        .option("--button [name]", "click: left, right or middle")
        .option("--to <x,y>", "drag: global destination point")
        .option("--duration <seconds>", "drag: duration from 0.1 to 5 seconds")
        .option("--pages <n>", "scroll: 1–20 receiving AX scroll-area viewport pages; if unavailable use --pixels")
        .option("--pixels <n>", "scroll: exact synthetic wheel pixels from 1 to 10000; mutually exclusive with --pages")
        .option("--range <start,length>", "select: UTF-16 selection range")
        .option("--prefix <text>", "select: immediate prefix before the unique text match")
        .option("--suffix <text>", "select: immediate suffix after the unique text match")
        .option("--selection [mode]", "select: text, cursor_before or cursor_after")
        .option("--format [name]", "paste: text, md or html; consumes the current selection")
        .action((opts: WorkflowOptions) => {
            if (typeof opts.action !== "string" || !ACTIONS.some((action) => action === opts.action)) {
                logger.error(suggestEnumFlag("tools control act", "--action", ACTIONS));
                process.exitCode = 1;
                return;
            }

            for (const [value, flag, choices] of [
                [opts.button, "--button", BUTTONS],
                [opts.direction, "--direction", DIRECTIONS],
                [opts.selection, "--selection", SELECTIONS],
                [opts.format, "--format", FORMATS],
            ] as const) {
                if (value !== undefined && (typeof value !== "string" || !choices.some((choice) => choice === value))) {
                    logger.error(suggestEnumFlag("tools control act", flag, choices));
                    process.exitCode = 1;
                    return;
                }
            }

            const args = [
                "act",
                "--app",
                opts.app,
                "--snapshot",
                opts.snapshot!,

                "--action",
                opts.action,
            ];

            if (opts.action === "type" && opts.text !== undefined && opts.text.length > 256) {
                logger.error("type text exceeds 256 UTF-16 units; use paste for longer text");
                process.exitCode = 1;
                return;
            }

            for (const [flag, value] of [
                ["value", opts.value],
                ["element", opts.element],
                ["coords", opts.coords],
                ["ax-action", opts.axAction],
                ["direction", opts.direction],
                ["text", opts.text],
                ["keys", opts.keys],
                ["button", opts.button],
                ["to", opts.to],
                ["duration", opts.duration],
                ["pages", opts.pages],
                ["pixels", opts.pixels],
                ["range", opts.range],
                ["prefix", opts.prefix],
                ["suffix", opts.suffix],
                ["selection", opts.selection],
                ["format", opts.format],
            ]) {
                if (typeof value === "string") {
                    args.push(`--${flag}`, value);
                }
            }

            if (opts.double) {
                args.push("--double");
            }

            if (opts.background) {
                args.push("--background");
            }

            const result = runAx(args, 30_000);
            out.result(result);
            process.exitCode = result.ok ? 0 : 1;
        });
}
