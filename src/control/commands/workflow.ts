import { readFileSync } from "node:fs";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { replayWorkflow } from "../lib/decision/workflow";
import { runAx } from "../lib/runner";
import { diffSnapshots, type SnapshotRow } from "../lib/snapshot-diff";
import { type ControlOptions, controlDriver, lazyEvaluator, observationOptions, withSigintAbort } from "./decision";

const ACTIONS = [
    "get",
    "press",
    "hover",
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
    image?: boolean;
    perception?: string | boolean;
    perceptionCrop?: string;
    perceptionWidth?: string;
    region?: string;
    windowIndex?: string;
    windowId?: string;
    windowTitle?: string;
    menu?: string;
    depth?: string;
    scope?: string | boolean;
    path?: string;
    snapshot?: string;
    element?: string;
    action?: string | boolean;
    value?: string;
    axAction?: string;
    expectTitle?: string;
    direction?: string | boolean;
    text?: string;
    keys?: string;
    double?: boolean;
    hold?: boolean;
    activate?: boolean;
    dwell?: string;
    coords?: string;
    frame?: string;
    background?: boolean;
    prepare?: boolean;
    replace?: boolean;
    targetKey?: string;
    revalidateScope?: string;
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
    refresh?: boolean;
    since?: string;
}

interface PreviousSnapshot {
    elements: SnapshotRow[];
    window?: { id?: number };
}

function isSnapshotRow(value: unknown): value is SnapshotRow {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const row = value as Record<string, unknown>;
    return typeof row.index === "number" && typeof row.depth === "number" && typeof row.role === "string";
}

/** Narrows the whole array, so the caller never assigns an `any[]` into `SnapshotRow[]`. */
function isSnapshotRows(value: unknown): value is SnapshotRow[] {
    return Array.isArray(value) && value.every(isSnapshotRow);
}

function isSnapshotWindow(value: unknown): value is { id?: number } {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const id = (value as Record<string, unknown>).id;
    return id === undefined || typeof id === "number";
}

/**
 * The `--since` file is whatever path the caller typed. A missing file, a half-written one, or a
 * `{}` that would make every current row read as added must not throw: the AX walk has already
 * happened, and discarding that result to report a bad argument loses the more valuable half.
 * `comparable: false` is the shape the window-id mismatch already uses.
 */
function readPreviousSnapshot(file: string): PreviousSnapshot | { reason: string } {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(file, "utf8"), { strict: true });
    } catch (error) {
        logger.debug({ error, file }, "see --since could not read the previous snapshot");
        const detail = error instanceof Error ? error.message : String(error);
        return { reason: `previous snapshot unreadable (${detail}); full elements returned` };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { reason: "previous snapshot is not a see result; full elements returned" };
    }

    const fields = parsed as Record<string, unknown>;

    if (!isSnapshotRows(fields.elements)) {
        return { reason: "previous snapshot has no usable elements[]; full elements returned" };
    }

    if (fields.window !== undefined && !isSnapshotWindow(fields.window)) {
        return { reason: "previous snapshot has an unusable window; full elements returned" };
    }

    return { elements: fields.elements, window: fields.window };
}

/** `see --since`: keep the token, window and screenshot; replace the rows with what moved. */
export function sinceSnapshot(previousFile: string, current: Record<string, unknown>): Record<string, unknown> {
    const previous = readPreviousSnapshot(previousFile);

    if ("reason" in previous) {
        return { ...current, since: { file: previousFile, comparable: false, reason: previous.reason } };
    }

    const rows = (current.elements as SnapshotRow[] | undefined) ?? [];
    const currentWindow = current.window as { id?: number } | undefined;

    if (
        previous.window?.id !== undefined &&
        currentWindow?.id !== undefined &&
        previous.window.id !== currentWindow.id
    ) {
        return {
            ...current,
            since: { file: previousFile, comparable: false, reason: "different window id; full elements returned" },
        };
    }

    const diff = diffSnapshots(previous.elements, rows);
    const moved = new Set([...diff.added.map((r) => r.index), ...diff.changed.map((c) => c.index)]);
    const { elements: _all, ...rest } = current;

    return {
        ...rest,
        elementCount: rows.length,
        elements: rows.filter((r) => moved.has(r.index)),
        changes: {
            added: diff.added.map((r) => r.index),
            removed: diff.removed,
            changed: diff.changed,
            unchanged: diff.unchanged,
            indexMap: diff.indexMap,
        },
        since: { file: previousFile, comparable: true, previousElements: previous.elements.length },
    };
}

interface AxWindowRow {
    title?: string;
    minimized?: boolean;
}

/**
 * Title to AX window index, failing loud on 0 or 2+ matches — the behaviour
 * `screenshot --window` already has, and the reason `see` could not be driven
 * from a title before.
 *
 * The index is the RAW position in `window --app`'s array, because that is what
 * `see --window-index` counts. Do not filter the array before indexing it: a
 * minimized window still occupies its slot.
 *
 * 🛑 This is two calls, so a window closing or reordering between them would
 * hand `see` an index that now points somewhere else. It cannot be closed by
 * passing `--window-id` instead: `window --app` reports an AXIdentifier
 * (`"FinderWindow"`), not the CG window id `see` accepts. So the caller RE-CHECKS
 * the title on the window `see` actually returned and refuses on a mismatch —
 * the race is detected rather than prevented, which is the difference between a
 * loud retry and silently driving the wrong window.
 */
function resolveWindowTitle(app: string, substring: string): { index: number } | { error: string } {
    const listed = runAx(["window", "--app", app]);

    if (!listed.ok) {
        return { error: `could not list windows of ${app}: ${String(listed.error)}` };
    }

    const windows = ((listed as { windows?: AxWindowRow[] }).windows ?? []).map((row, index) => ({
        index,
        title: row.title ?? "",
        minimized: row.minimized === true,
    }));
    const needle = substring.toLowerCase();
    const matches = windows.filter((row) => row.title.toLowerCase().includes(needle));
    const candidates = windows
        .map((row) => `  ${row.index}: ${row.title || "(untitled)"}${row.minimized ? " [minimized]" : ""}`)
        .join("\n");

    if (matches.length === 1) {
        return { index: (matches[0] as { index: number }).index };
    }

    const verb = matches.length === 0 ? "no window title contains" : `${matches.length} window titles contain`;
    return { error: `${verb} "${substring}" in ${app}. Windows:\n${candidates || "  (none)"}` };
}

/**
 * The surface a see/menu-see snapshot token was taken from.
 *
 * The token is base64 JSON carrying its own `surface`, so `act` can route a menu snapshot to the
 * native menu dispatcher without the caller naming the surface twice. That is the whole reason
 * this folds into see/act rather than living as a `control menu` pair: a second command would be
 * a second addressing scheme for the same indexes, and a caller reading `control --help` would
 * still have to know the menu door exists before finding it.
 */
function snapshotSurface(token: string): "menu" | "window" {
    try {
        const decoded = SafeJSON.parse(Buffer.from(token, "base64").toString("utf8"), { strict: true });

        return (decoded as { surface?: unknown }).surface === "menu" ? "menu" : "window";
    } catch (error) {
        // An unreadable token is not this function's refusal to make: the native side validates
        // it and says why. Treat it as the ordinary surface and let that refusal through.
        logger.debug({ error }, "snapshot token is not readable base64 JSON; treating it as a window snapshot");

        return "window";
    }
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
        .option(
            "--window-title <substring>",
            "select the window whose title contains this (case-insensitive); 0 or 2+ matches exit 1 with the candidates"
        )
        .option("--depth <n>", "tree depth, 1–50; refuses truncated trees", "20")
        .option(
            "--scope [name]",
            "window (default), chrome (omit web-area descendants for browser controls), or menu (the app's MENU BAR; pair with --menu to descend into one top-level menu)"
        )
        .option(
            "--menu <title>",
            "with --scope menu: descend into exactly this top-level menu instead of listing the bar"
        )
        .option("--path <png>", "save screenshot here (default: unique temporary PNG)")
        .option("--no-image", "Read AX state without creating a screenshot")
        .option("--perception [mode]", "Native local OCR regions bound to this screenshot: ocr")
        .option("--perception-crop <x,y,w,h>", "Crop OCR input in original source pixels; retain original screenshot")
        .option("--perception-width <pixels>", "Resize cropped OCR input to this width, 64–8192")
        .option(
            "--since <json>",
            "a previous see result for the same window; output carries changes and only the rows that moved"
        )
        .action((opts: WorkflowOptions) => {
            if (opts.scope !== undefined && !["window", "chrome", "menu"].includes(String(opts.scope))) {
                logger.error(suggestEnumFlag("tools control see", "--scope", ["window", "chrome", "menu"]));
                process.exitCode = 1;
                return;
            }

            if (opts.menu !== undefined && opts.scope !== "menu") {
                logger.error("--menu names a top-level menu and only applies to --scope menu");
                process.exitCode = 1;
                return;
            }

            // 🛑 The menu surface is a different native command with a different root, so none of
            // the window flags below apply to it. Routing here keeps one verb for the caller while
            // refusing the combinations that would silently be ignored.
            if (opts.scope === "menu") {
                const menuArgs = ["menu-see", "--app", opts.app];

                if (opts.menu !== undefined) {
                    menuArgs.push("--menu", opts.menu);
                }

                const menuResult = runAx(menuArgs, 30_000);
                out.result(menuResult);
                process.exitCode = menuResult.ok ? 0 : 1;
                return;
            }
            if (opts.perception !== undefined && opts.perception !== "ocr") {
                logger.error(suggestEnumFlag("tools control see", "--perception", ["ocr"]));
                process.exitCode = 1;
                return;
            }
            const args = ["see", "--app", opts.app];
            if (opts.image === false) {
                args.push("--no-image");
            }
            if (typeof opts.scope === "string") {
                args.push("--scope", opts.scope);
            }

            // Titles are what an agent knows; indexes reorder whenever a window is
            // focused or closed, so every run otherwise needed a title-to-index
            // step of its own. Resolved through `window --app`, which reports AX
            // geometry per window and costs far less than a second tree walk.
            if (opts.windowTitle !== undefined) {
                if (opts.windowIndex !== undefined || opts.windowId !== undefined) {
                    logger.error("--window-title cannot be combined with --window-index or --window-id");
                    process.exitCode = 1;
                    return;
                }

                const resolved = resolveWindowTitle(opts.app, opts.windowTitle);

                if ("error" in resolved) {
                    logger.error(resolved.error);
                    process.exitCode = 1;
                    return;
                }

                args.push("--window-index", String(resolved.index));
            }

            for (const [flag, value] of [
                ["window-index", opts.windowIndex],
                ["window-id", opts.windowId],
                ["depth", opts.depth],
                ["perception", typeof opts.perception === "string" ? opts.perception : undefined],
                ["perception-crop", opts.perceptionCrop],
                ["perception-width", opts.perceptionWidth],
                ["path", opts.path],
            ]) {
                if (value !== undefined) {
                    args.push(`--${flag}`, value);
                }
            }

            const result = runAx(args, 30_000);

            if (opts.windowTitle !== undefined && result.ok) {
                const seenTitle = (result as { window?: { title?: string } }).window?.title;

                if (
                    typeof seenTitle === "string" &&
                    !seenTitle.toLowerCase().includes(opts.windowTitle.toLowerCase())
                ) {
                    logger.error(
                        `--window-title "${opts.windowTitle}" resolved to a window titled "${seenTitle}". ` +
                            `The windows changed between listing and reading them; run see again.`
                    );
                    process.exitCode = 1;
                    return;
                }
            }

            out.result(result.ok && opts.since ? sinceSnapshot(opts.since, result) : result);
            process.exitCode = result.ok ? 0 : 1;
        });

    program
        .command("act")
        .description(
            "Act on an element from see after validating app instance, window, age and tree. Refuses stale refs; never retries or falls back. Output is JSON. Run see again after every action. Default click/type/key require the target window already focused; focus is explicit. click --background uses window-addressed delivery without moving the pointer. A `see --scope menu` snapshot is routed to the menu dispatcher automatically and takes --action perform (with --ax-action, default AXPress) or --action press."
        )
        .requiredOption("--app <name>", "same app instance as the snapshot")
        .requiredOption("--snapshot <token>", "opaque token returned by see")
        .option("--element <n>", "element index copied from that snapshot; alternative to click --coords")
        .option("--action [name]", `one of: ${ACTIONS.join(", ")}`)
        .option("--value <text>", "set: AXValue text, read back to verify; no keystrokes")
        .option(
            "--ax-action <name>",
            "perform: exact action from the element's actions list. With a `see --scope menu` snapshot this is the menu item's action and defaults to AXPress."
        )
        .option(
            "--expect-title <text>",
            "menu snapshots: refuse unless the row at --element carries exactly this title. Menu indexes shift between observations, so pass the title you read beside the index."
        )
        .option("--direction [name]", "scroll: direction up, down, left or right; page or pixel wheel mode")
        .option("--text <text>", "type/select/paste: text; type is single-line and limited to 256 UTF-16 units")
        .option(
            "--keys <combo>",
            "key: comma-separated modifiers cmd,ctrl,alt,shift plus a letter, digit, return, tab, escape, backspace or arrow"
        )
        .option("--double", "click: double-click the observed element")
        .option(
            "--hold",
            "hover: leave the real pointer on the target instead of putting it back. A control revealed by hover exists only while the pointer is over it, so hold it when the next act must press one. Restore with `control restore`."
        )
        .option(
            "--dwell <ms>",
            "hover: hold the real pointer on the target for this long, 1–10000, default 400. The tree is read DURING the hold and returned as `during`, with a `revealed` list of what appeared; the pointer is then put back where it was."
        )
        .option(
            "--coords <x,y>",
            "click/move/drag/scroll/hover: a point, read in the frame --frame names. Default `screen` means a GLOBAL LOGICAL screen point, the frame a see row reports as its `screen` rect (negative display origins included). NOT screenshot pixels: that is the same row's `source` rect."
        )
        .option(
            "--frame <name>",
            "window | screen (default screen). `window` reads --coords relative to the window's CURRENT origin, so the point survives the window moving between see and act. The result echoes coordinateFrame, requestedPoint and the resolvedPoint it acted on."
        )
        .option(
            "--region <id>",
            "click/move/drag/scroll: observed OCR region ID; revalidates pixels and consumes capture"
        )
        .option("--background", "click/move/drag/scroll: deliver without explicit activation or pointer movement")
        .option(
            "--no-activate",
            "key/type/paste/select/set: deliver to the target process without bringing it frontmost. Keys already route through CGEvent.postToPid, so this waives only the key-window requirement; the focused-element check still decides where the text lands. Every result reports frontmostChanged."
        )
        .option(
            "--prepare",
            "Element click/key/text: focus, reveal and revalidate the same observed target before input"
        )
        .option(
            "--target-key <hash>",
            "Native targetKey from the observed row; identity for --prepare or --revalidate-scope element"
        )
        .option(
            "--revalidate-scope <scope>",
            "element | window | app (default window). `element` checks only that the row at --element still carries --target-key, so a window whose clock or status text ticks stays actionable instead of refusing every act with stale_observation."
        )
        .option("--replace", "paste with --prepare: select all, paste once and verify exact field readback")
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
        .option(
            "--refresh",
            "settle, then return the post-action snapshot under `after`; one round trip instead of two"
        )
        .option("--path <png>", "with --refresh: save the post-action screenshot here")
        .option("--no-image", "with --refresh: return AX state without a post-action screenshot")
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

            // A menu snapshot indexes a menu tree, not a window tree, and the native side keeps
            // them apart. Reading the surface off the token means the caller says it once, in
            // `see --scope menu`, instead of again here.
            if (snapshotSurface(opts.snapshot!) === "menu") {
                if (opts.action !== "perform" && opts.action !== "press") {
                    logger.error(
                        `a menu snapshot takes --action perform (with --ax-action) or --action press; got "${String(opts.action)}"`
                    );
                    process.exitCode = 1;
                    return;
                }

                if (opts.element === undefined) {
                    logger.error("a menu snapshot needs --element <n> from that same see --scope menu");
                    process.exitCode = 1;
                    return;
                }

                const menuArgs = [
                    "menu-act",
                    "--app",
                    opts.app,
                    "--snapshot",
                    opts.snapshot!,
                    "--element",
                    String(opts.element),
                    "--action",
                    opts.axAction ?? "AXPress",
                ];

                if (opts.expectTitle !== undefined) {
                    menuArgs.push("--expect-title", opts.expectTitle);
                }

                const menuResult = runAx(menuArgs);
                out.result(menuResult);
                process.exitCode = menuResult.ok ? 0 : 1;
                return;
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
                ["target-key", opts.targetKey],
                ["revalidate-scope", opts.revalidateScope],
                ["coords", opts.coords],
                ["frame", opts.frame],
                ["region", opts.region],
                ["ax-action", opts.axAction],
                ["direction", opts.direction],
                ["text", opts.text],
                ["keys", opts.keys],
                ["button", opts.button],
                ["to", opts.to],
                ["duration", opts.duration],
                ["dwell", opts.dwell],
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

            if (opts.prepare) {
                args.push("--prepare");
            }

            if (opts.replace) {
                args.push("--replace");
            }

            if (opts.hold) {
                args.push("--hold");
            }

            // Commander maps `--no-activate` to `activate: false`.
            if (opts.activate === false) {
                args.push("--no-activate");
            }

            if (opts.background) {
                args.push("--background");
            }

            if (opts.refresh) {
                args.push("--refresh");
            }
            if (opts.image === false) {
                args.push("--no-image");
            }

            if (typeof opts.path === "string") {
                args.push("--path", opts.path);
            }

            const result = runAx(args, 30_000);
            out.result(result);
            process.exitCode = result.ok ? 0 : 1;
        });
}

/**
 * The CLI door for `replayWorkflow`, the same core the MCP `run_workflow` tool calls.
 *
 * It was reachable from the MCP server and from a Bun import, and from nowhere on the command
 * line: `rg run_workflow src/control/commands` returned nothing. So a multi-step sequence — press
 * this, then that, then check — could not be expressed by a CLI caller at all, and a live session
 * driving a real app had to hand-roll one see/act pair per step and lose every guard the workflow
 * runner provides between them. That is the failure the repo's one-core-three-doors rule exists to
 * prevent, and it is the second instance of it found in this area in one day.
 *
 * The plan format is `workflowPlanSchema`: {version:1, app, scope?, windowTitle?, steps:[…]}. Each
 * step names an action, a selector, an intent and a postcondition. Supplied values stay local and
 * are passed by reference, never inlined into the plan.
 */
export function registerWorkflowRunCommand(program: Command): void {
    const workflow = program
        .command("workflow")
        .description(
            "Run a versioned multi-step plan inside one pinned app window, with a fresh postcondition per step and one shared deadline. This is the CLI door to the same runner the MCP `run_workflow` tool uses."
        );

    observationOptions(
        workflow
            .command("run")
            .description(
                "Replay a workflow plan file. Exact postconditions make no model call; a semantic postcondition or selector repair requires --jev."
            )
    )
        .requiredOption("--plan <file>", "JSON workflow plan: {version:1, app, steps:[…]}")
        .option("--values <file>", "JSON object of named values the plan refers to by valueRef; they stay local")
        .option("--jev", "Allow semantic postconditions and semantic selector choice")
        .option("--rebind", "Allow Jev to repair a selector that no longer matches; implies --jev")
        .option("--max-steps <n>", "Maximum steps to dispatch", "20")
        .option("--max-requests <n>", "Maximum paid evaluations", "30")
        .action(
            async (
                options: ControlOptions & {
                    plan: string;
                    values?: string;
                    jev?: boolean;
                    rebind?: boolean;
                    maxSteps: string;
                    maxRequests: string;
                }
            ) => {
                const plan = SafeJSON.parse(await Bun.file(options.plan).text());
                const values = options.values
                    ? (SafeJSON.parse(await Bun.file(options.values).text()) as Record<string, string>)
                    : undefined;

                // The plan names the app, so the driver must be built from it rather than from
                // --app. Passing both and disagreeing would pin the window of one app and dispatch
                // the steps of another.
                const app = (plan as { app?: unknown }).app;

                if (typeof app !== "string" || app.trim().length === 0) {
                    out.log.error('the plan must name the app it drives: {"version":1,"app":"…","steps":[…]}');
                    process.exitCode = 1;
                    return;
                }

                if (options.app !== undefined && options.app !== app) {
                    out.log.error(
                        `--app ${options.app} disagrees with the plan's app ${app}; drop --app or fix the plan`
                    );
                    process.exitCode = 1;
                    return;
                }

                await withSigintAbort(async (signal) => {
                    const result = await replayWorkflow({
                        plan,
                        values,
                        rebind: options.rebind === true,
                        jev: options.jev === true || options.rebind === true,
                        driver: controlDriver({ ...options, app }),
                        evaluate: lazyEvaluator(program),
                        signal,
                        limits: {
                            timeoutMs: Number(options.timeout),
                            maxActions: Number(options.maxSteps),
                            maxRequests: Number(options.maxRequests),
                        },
                    });
                    out.result(result);

                    if (result.status !== "verified") {
                        process.exitCode = 1;
                    }
                });
            }
        );
}
