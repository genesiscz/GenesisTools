import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import type { Command } from "commander";
import pc from "picocolors";
import { type AxResult, runAx } from "../lib/runner";
import { addTargetOptions, targetArgs, targetLabel } from "../lib/target";

/**
 * `--to-pid` was accepted for any integer. Measured 2026-09-09:
 * `hotkey --keys cmd,b --to-pid 99999` printed `sent cmd,b` and exited 0 with no
 * such process, and `type --to-pid 99999` printed `typed 1 chars`. Both had
 * silently fallen back to the GLOBAL tap, so the keystroke went to whatever the
 * human had focused. The SKILL already claimed "an invalid pid is rejected
 * rather than downgraded to the global tap"; this makes that true.
 *
 * The shared liveness helper signals nothing and only asks whether the process
 * exists: EPERM means it exists and is not ours, which is still a real target.
 */
export function validateToPid(toPid: string | undefined): string | null {
    if (toPid == null) {
        return null;
    }

    const pid = Number(toPid);

    if (!/^\d+$/.test(toPid) || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) {
        return `--to-pid ${toPid} is not a process id. No event was posted.`;
    }

    return isProcessAlive(pid) ? null : `--to-pid ${pid} names no running process. No event was posted.`;
}

/**
 * What `control type` may print. "typed N chars" is a claim that the text reached a field, so it
 * is printed only when the native side read the field back. Measured 2026-09-28: `type --app
 * "Brave Browser"` printed "typed 66 chars" while an open panel's field stayed empty, because the
 * untargeted path verified nothing. Keys that were sent but not proven land exit 2, not 0.
 */
export function typeOutcome(result: AxResult, app: string): { line: string; exitCode: number } {
    const count = String(result.length ?? "?");
    const target = String(result.axId ?? result.desc ?? result.focused ?? app);
    if (result.ok && result.verified === true) {
        return { line: `${pc.green("typed")} ${pc.bold(count)} chars into ${pc.cyan(target)}`, exitCode: 0 };
    }

    if (!result.ok && result.unverified !== true) {
        return { line: String(result.error ?? "typing failed"), exitCode: 1 };
    }

    const warning = typeof result.warning === "string" ? result.warning : "nothing read the text back";
    return {
        line: `${pc.yellow("sent")} ${pc.bold(count)} keystrokes toward ${pc.cyan(target)}, ${pc.yellow("UNVERIFIED")}: ${warning}`,
        exitCode: 2,
    };
}

/**
 * The focus-safe path is `see` + `act`, which refuses when the target is not
 * frontmost instead of typing into the human's window. These verbs predate it
 * and still post global events, so each run says so once, on stderr, where it
 * cannot corrupt `--json` on stdout.
 */
/**
 * The human `ocr` output: a header saying what was read, then the recognised text. With the count
 * printed last and nothing first, the text read as leaked debug output (#447).
 */
export function ocrReport(result: AxResult): string[] {
    const blocks = Array.isArray(result.blocks) ? (result.blocks as Array<{ text?: string }>) : [];
    const source =
        typeof result.image === "string"
            ? result.image
            : `"${String(result.app ?? "?")}" window "${String(result.window ?? "(untitled)")}"`;
    const size = typeof result.width === "number" ? ` (${result.width}x${result.height} px)` : "";
    const count = `${blocks.length} text ${blocks.length === 1 ? "block" : "blocks"}`;
    return [`OCR of ${source}${size}: ${count}`, ...blocks.map((b) => String(b.text ?? ""))];
}

function noteLegacyKeyboardVerb(verb: string): void {
    out.log.warn(
        `\`control ${verb}\` posts global keyboard events and can land in whatever window is frontmost. ` +
            `The focus-safe replacement is \`control see\` then \`control act\`, which refuses a wrong frontmost window.`
    );
}

export function scrollTimeoutMs(options: { time?: string; repeat?: string; pause?: string }): number {
    const finite = (value: string | undefined, fallback: number): number => {
        const number = Number(value);
        return value !== undefined && Number.isFinite(number) ? number : fallback;
    };
    const repeat = finite(options.repeat, 1);
    const seconds = finite(options.time, 0) * repeat + finite(options.pause, 0.3) * Math.max(0, repeat - 1);

    return Number.isFinite(seconds * 1000) ? Math.max(10_000, Math.ceil(seconds * 1000) + 10_000) : 10_000;
}

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
                process.exit(result.ok === false ? 1 : 0);
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
                process.exit(result.ok === false ? 1 : 0);
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
                process.exit(result.ok === false ? 1 : 0);
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
                process.exit(result.ok === false ? 1 : 0);
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
        .option("--no-activate", "focus the element WITHOUT raising the app (never steals the user's window)")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["focus", "--app", opts.app, ...targetArgs(opts)];

            // Commander maps `--no-activate` to `activate: false`.
            if (opts.activate === false) {
                axArgs.push("--no-activate");
            }

            const result = runAx(axArgs);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(result.ok === false ? 1 : 0);
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
                process.exit(result.ok === false ? 1 : 0);
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
                "Type keystrokes + HARD VERIFY. Inserts at the CURRENT cursor — use --end to jump to the end first, --clear to replace the whole field. Without a target the focused element is read back; exit 2 means the keys were sent but nothing proved where they landed."
            )
            .requiredOption("--app <name>", "app process name")
            .requiredOption("--text <text>", "text to type")
    )
        .option("--clear", "select-all + delete before typing (replace field content)")
        .option("--end", "move the cursor to the end of the field before typing (append)")
        .option("--return", "press Return after typing")
        .option("--delay <ms>", "ms between keystrokes (default 8)")
        .option("--to-pid <pid>", "deliver the keystrokes to THIS process only, not the global HID tap")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            noteLegacyKeyboardVerb("type");
            const pidError = validateToPid(opts.toPid);

            if (pidError) {
                logger.error(pidError);
                process.exit(1);
            }

            const axArgs = ["type", "--app", opts.app, "--text", opts.text, ...targetArgs(opts)];
            if (opts.toPid) {
                axArgs.push("--to-pid", String(opts.toPid));
            }

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
            const outcome = typeOutcome(result, opts.app);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(outcome.exitCode);
            }
            if (outcome.exitCode === 1) {
                logger.error(outcome.line);
                process.exit(1);
            }
            out.println(outcome.line);
            process.exitCode = outcome.exitCode;
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
        .option("--to-pid <pid>", "deliver the combo to THIS process only, not the global HID tap")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            noteLegacyKeyboardVerb("hotkey");
            const pidError = validateToPid(opts.toPid);

            if (pidError) {
                logger.error(pidError);
                process.exit(1);
            }

            const axArgs = ["hotkey", "--keys", opts.keys];
            if (opts.app) {
                axArgs.push("--app", opts.app);
            }
            if (opts.hold) {
                axArgs.push("--hold", opts.hold);
            }
            if (opts.toPid) {
                axArgs.push("--to-pid", String(opts.toPid));
            }
            const result = runAx(axArgs);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(result.ok === false ? 1 : 0);
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
                "Scroll: --direction sends wheel events to the window under the point (element center / --coords / the main window's center) without taking focus; WITHOUT --direction scrolls the target element into view (AXScrollToVisible). --time spreads the distance over real time like a trackpad flick; --repeat with --alternate scrolls down and up again."
            )
            .requiredOption("--app <name>", "app process name")
    )
        .option("--direction <dir>", "up | down | left | right (wheel mode)")
        .option("--amount <n>", "wheel lines to scroll, 40 px each (default 3)")
        .option("--pixels <n>", "distance in pixels instead of --amount (1–100000)")
        .option(
            "--time <seconds>",
            "spread the distance over this time, 60 events per second (0.05–30); default one event"
        )
        .option("--ease <curve>", "flick (fast, then slowing; default) | linear (same speed)")
        .option("--repeat <n>", "scroll this many times (1–200)")
        .option("--pause <seconds>", "pause between repeats (default 0.3)")
        .option("--alternate", "every second repeat goes the other way (down, up, down, …)")
        .option(
            "--foreground",
            "bring the app frontmost first (the old path, for an app that ignores background window events)"
        )
        .option("--coords <x,y>", "scroll at this screen point instead of an element")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["scroll", "--app", opts.app, ...targetArgs(opts)];
            const passThrough: [string, string | undefined][] = [
                ["--direction", opts.direction],
                ["--amount", opts.amount],
                ["--pixels", opts.pixels],
                ["--time", opts.time],
                ["--ease", opts.ease],
                ["--repeat", opts.repeat],
                ["--pause", opts.pause],
                ["--coords", opts.coords],
            ];
            for (const [flag, value] of passThrough) {
                if (value) {
                    axArgs.push(flag, value);
                }
            }

            if (opts.alternate) {
                axArgs.push("--alternate");
            }

            if (opts.foreground) {
                axArgs.push("--foreground");
            }

            // A timed, repeated scroll runs for as long as it was asked to, plus the usual margin.
            const result = runAx(axArgs, scrollTimeoutMs(opts));
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(result.ok === false ? 1 : 0);
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            if (result.method === "AXScrollToVisible") {
                out.println(`${pc.green("scrolled into view")} ${pc.cyan(targetLabel(opts, result))}`);
            } else {
                out.println(
                    `${pc.green("scrolled")} ${opts.direction} ${result.pixels}px in ${result.events} events${result.time ? ` over ${result.time}s` : ""}${Number(result.repeat) > 1 ? ` ×${result.repeat}${result.alternate ? " alternating" : ""}` : ""} (${result.method})`
                );
            }
        });

    program
        .command("screenshot")
        .description(
            "Window screenshot via CGWindowList. --window fails loud on 0 or 2+ title matches; --window-id takes the exact id `see` reported and is the only way to reach one of two same-titled windows; unscoped picks the largest window. --annotate draws numbered boxes on interactable elements + returns a legend."
        )
        .requiredOption("--app <name>", "app process name")
        .requiredOption("--path <file>", "output PNG path")
        .option("--window <title>", "target specific window by title substring")
        .option("--window-id <id>", "target the exact window id `see` reported; reaches one of two same-titled windows")
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

            if (opts.windowId) {
                axArgs.push("--window-id", String(opts.windowId));
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
                process.exit(result.ok === false ? 1 : 0);
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
        .option("--window <title>", "with --app: target a specific window by title substring")
        .option("--window-id <id>", "with --app: the exact window id `see` reported")
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
                if (opts.window) {
                    axArgs.push("--window", opts.window);
                }

                if (opts.windowId) {
                    axArgs.push("--window-id", String(opts.windowId));
                }
            }
            if (opts.crop) {
                axArgs.push("--crop", opts.crop);
            }
            const result = runAx(axArgs, 30_000);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                process.exit(result.ok === false ? 1 : 0);
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            for (const line of ocrReport(result)) {
                out.println(line);
            }
        });
}
