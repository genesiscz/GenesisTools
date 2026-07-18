import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";
import { runAx } from "../lib/runner";
import { addTargetOptions, targetArgs, targetLabel } from "../lib/target";

export function registerInteractCommands(program: Command): void {
    addTargetOptions(
        program
            .command("get")
            .description("Read attributes of an element")
            .requiredOption("--app <name>", "app process name")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["get", "--app", opts.app, ...targetArgs(opts)]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(`${pc.bold(targetLabel(opts, result))}`);
            if (result.role) {
                out.println(`  role:  ${result.role}`);
            }
            if (result.title) {
                out.println(`  title: ${result.title}`);
            }
            if (result.desc) {
                out.println(`  desc:  ${result.desc}`);
            }
            if (result.value !== undefined) {
                out.println(`  value: ${pc.green(String(result.value))}`);
            }
        });

    addTargetOptions(
        program
            .command("set")
            .description("Set value of a text field")
            .requiredOption("--app <name>", "app process name")
            .requiredOption("--value <text>", "value to set")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["set", "--app", opts.app, ...targetArgs(opts), "--value", opts.value]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(`${pc.green("set")} ${pc.cyan(targetLabel(opts, result))} = ${pc.bold(opts.value)}`);
        });

    addTargetOptions(
        program
            .command("press")
            .description("Press (AXPress) an element")
            .requiredOption("--app <name>", "app process name")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["press", "--app", opts.app, ...targetArgs(opts)]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(`${pc.green("pressed")} ${pc.cyan(targetLabel(opts, result))}`);
        });

    addTargetOptions(
        program
            .command("perform")
            .description("Perform any AX action on an element (generic version of press)")
            .requiredOption("--app <name>", "app process name")
            .requiredOption("--action <action>", "AX action name (e.g. AXPress, AXShowMenu, AXRaise)")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["perform", "--app", opts.app, ...targetArgs(opts), "--action", opts.action]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(`${pc.green("performed")} ${pc.cyan(opts.action)} on ${pc.cyan(opts.id)}`);
        });

    addTargetOptions(
        program
            .command("focus")
            .description("Activate app and optionally focus a specific element")
            .requiredOption("--app <name>", "app process name")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["focus", "--app", opts.app, ...targetArgs(opts)]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            const target = result.axId ?? result.desc ?? result.title ?? opts.app;
            out.println(`${pc.green("focused")} ${pc.cyan(String(target))}`);
        });

    addTargetOptions(
        program
            .command("click")
            .description("CGEvent click at element center — no coordinates needed")
            .requiredOption("--app <name>", "app process name")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["click", "--app", opts.app, ...targetArgs(opts)]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            const target = result.axId ?? result.desc ?? result.title ?? "?";
            out.println(`${pc.green("clicked")} ${pc.cyan(String(target))} at (${result.x},${result.y})`);
        });

    addTargetOptions(
        program
            .command("type")
            .description("Type keystrokes into app, optionally focusing an element first")
            .requiredOption("--app <name>", "app process name")
            .requiredOption("--text <text>", "text to type")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["type", "--app", opts.app, "--text", opts.text, ...targetArgs(opts)]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(
                `${pc.green("typed")} ${pc.bold(String(result.length))} chars into ${pc.cyan(String(result.axId ?? result.desc ?? opts.app))}`
            );
        });

    program
        .command("hotkey")
        .description(
            "Send key combo via CGEvent. --app activates the target first (refuses if it cannot become frontmost)"
        )
        .requiredOption("--keys <keys>", "comma-separated: cmd,shift,a")
        .option("--app <name>", "activate this app before sending keys")
        .option("--hold <ms>", "ms between key down and up")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["hotkey", "--keys", opts.keys];
            if (opts.app) {
                axArgs.push("--app", opts.app);
            }
            if (opts.hold) {
                axArgs.push("--hold", opts.hold);
            }
            const result = runAx(axArgs);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(`${pc.green("sent")} ${pc.cyan(opts.keys)}`);
        });

    program
        .command("screenshot")
        .description(
            "Window screenshot via CGWindowList. --window fails loud on 0 or 2+ title matches; unscoped picks the largest window."
        )
        .requiredOption("--app <name>", "app process name")
        .requiredOption("--path <file>", "output PNG path")
        .option("--window <title>", "target specific window by title substring")
        .option("--crop <x,y,w,h>", "crop in PIXELS of the captured image (origin top-left)")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["screenshot", "--app", opts.app, "--path", opts.path];
            if (opts.window) {
                axArgs.push("--window", opts.window);
            }
            if (opts.crop) {
                axArgs.push("--crop", opts.crop);
            }
            const result = runAx(axArgs);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(
                `${pc.green("captured")} ${result.window} ${result.width}x${result.height} -> ${pc.dim(String(result.path))}`
            );
        });
}
