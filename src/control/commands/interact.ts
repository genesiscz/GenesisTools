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
            .description(
                "Type keystrokes + HARD VERIFY. Inserts at the CURRENT cursor — use --end to jump to the end first, --clear to replace the whole field."
            )
            .requiredOption("--app <name>", "app process name")
            .requiredOption("--text <text>", "text to type")
    )
        .option("--clear", "select-all + delete before typing (replace field content)")
        .option("--end", "move the cursor to the end of the field before typing (append)")
        .option("--return", "press Return after typing")
        .option("--delay <ms>", "ms between keystrokes (default 8)")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["type", "--app", opts.app, "--text", opts.text, ...targetArgs(opts)];
            if (opts.clear) {
                axArgs.push("--clear");
            }
            if (opts.end) {
                axArgs.push("--end");
            }
            if (opts.return) {
                axArgs.push("--return");
            }
            if (opts.delay) {
                axArgs.push("--delay", opts.delay);
            }
            const result = runAx(axArgs, 30_000);
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
        .requiredOption(
            "--keys <keys>",
            "comma-separated: cmd,shift,a — or a bare key: escape, return, tab, delete, up/down (aliases: esc, enter, backspace)"
        )
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

    addTargetOptions(
        program
            .command("scroll")
            .description(
                "Scroll: --direction sends wheel events (at element center / --coords / screen center); WITHOUT --direction scrolls the target element into view (AXScrollToVisible)."
            )
            .requiredOption("--app <name>", "app process name")
    )
        .option("--direction <dir>", "up | down | left | right (wheel mode)")
        .option("--amount <n>", "wheel lines to scroll (default 3)")
        .option("--coords <x,y>", "scroll at this screen point instead of an element")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["scroll", "--app", opts.app, ...targetArgs(opts)];
            if (opts.direction) {
                axArgs.push("--direction", opts.direction);
            }
            if (opts.amount) {
                axArgs.push("--amount", opts.amount);
            }
            if (opts.coords) {
                axArgs.push("--coords", opts.coords);
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
            if (result.method === "AXScrollToVisible") {
                out.println(`${pc.green("scrolled into view")} ${pc.cyan(targetLabel(opts, result))}`);
            } else {
                out.println(`${pc.green("scrolled")} ${opts.direction} x${result.amount}`);
            }
        });

    program
        .command("screenshot")
        .description(
            "Window screenshot via CGWindowList. --window fails loud on 0 or 2+ title matches; unscoped picks the largest window. --annotate draws numbered boxes on interactable elements + returns a legend."
        )
        .requiredOption("--app <name>", "app process name")
        .requiredOption("--path <file>", "output PNG path")
        .option("--window <title>", "target specific window by title substring")
        .option("--crop <x,y,w,h>", "crop in PIXELS of the captured image (origin top-left)")
        .option("--annotate", "draw numbered boxes around interactable elements (legend in JSON)")
        .option("--all", "with --annotate: box EVERY element with id/desc/title, not just interactable roles")
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
            if (opts.annotate) {
                axArgs.push("--annotate");
            }
            if (opts.all) {
                axArgs.push("--all");
            }
            const result = runAx(axArgs, 30_000);
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
            if (Array.isArray(result.annotations)) {
                out.println(pc.dim(`${result.annotations.length} annotated elements (legend in --json output)`));
            }
        });

    program
        .command("ocr")
        .description(
            "Vision OCR — read visible text from an app window (or --image file). Returns text blocks with pixel bounding boxes."
        )
        .option("--app <name>", "capture this app's window and OCR it")
        .option("--image <path>", "OCR an existing image file instead")
        .option("--crop <x,y,w,h>", "restrict OCR to this pixel region of the image")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            if (!opts.app && !opts.image) {
                logger.error("ocr needs --app <name> or --image <path>");
                process.exit(1);
            }
            const axArgs = ["ocr"];
            if (opts.image) {
                axArgs.push("--image", opts.image);
            } else {
                axArgs.push("--app", opts.app);
            }
            if (opts.crop) {
                axArgs.push("--crop", opts.crop);
            }
            const result = runAx(axArgs, 30_000);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            const blocks = Array.isArray(result.blocks) ? (result.blocks as Array<{ text?: string }>) : [];
            for (const b of blocks) {
                out.println(String(b.text ?? ""));
            }
            out.println(pc.dim(`${blocks.length} text blocks (--json for bounding boxes)`));
        });
}
