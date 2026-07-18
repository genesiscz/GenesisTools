import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";
import { runAx } from "../lib/runner";
import { addTargetOptions, targetArgs, targetLabel } from "../lib/target";

export function registerDiscoveryCommands(program: Command): void {
    program
        .command("list")
        .description("List AX elements in an app (identifiers, roles, values)")
        .requiredOption("--app <name>", "app process name")
        .option("--depth <n>", "max tree depth", "10")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["list", "--app", opts.app, "--depth", opts.depth]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            const elements = (result.elements as Array<Record<string, string>>) ?? [];
            out.println(pc.bold(`${result.app} — ${elements.length} elements\n`));
            for (const e of elements) {
                const id = e.id ? pc.cyan(e.id) : pc.dim("-");
                const role = pc.dim(e.role ?? "?");
                const label = e.title || e.desc || e.value || "";
                out.println(`  ${role.padEnd(30)} ${id.padEnd(40)} ${label}`);
            }
        });

    program
        .command("tree")
        .description("Hierarchical tree dump of AX elements (nested JSON)")
        .requiredOption("--app <name>", "app process name")
        .option("--depth <n>", "max tree depth", "10")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["tree", "--app", opts.app, "--depth", opts.depth]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
        });

    program
        .command("find")
        .description(
            "Search for elements. Note: many apps (Chromium browsers, SwiftUI) expose visible text via AXDescription — try --desc or --q when --title finds nothing."
        )
        .requiredOption("--app <name>", "app process name")
        .option("--role <role>", "filter by AXRole (fuzzy: 'button' matches AXButton)")
        .option("--title <title>", "filter by AXTitle (substring, case-insensitive)")
        .option("--value <value>", "filter by AXValue (substring, case-insensitive)")
        .option("--desc <desc>", "filter by AXDescription (substring, case-insensitive)")
        .option("--subrole <subrole>", "filter by AXSubrole (fuzzy: 'close' matches AXCloseButton)")
        .option("--text <query>", "search id+title+desc at once (OR)")
        .option("--q <query>", "universal search — id, title, desc, value, role, subrole")
        .option("--window <title>", "scope search to windows matching this title substring")
        .option("--exact", "force strict role/subrole matching")
        .option("--depth <n>", "max search depth", "15")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["find", "--app", opts.app, "--depth", opts.depth];
            for (const flag of ["role", "title", "value", "desc", "subrole", "text", "q", "window"] as const) {
                if (opts[flag]) {
                    axArgs.push(`--${flag}`, opts[flag]);
                }
            }
            if (opts.exact) {
                axArgs.push("--exact");
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
            const matches = (result.matches as Array<Record<string, string>>) ?? [];
            out.println(pc.bold(`${result.app} — ${matches.length} matches\n`));
            for (const e of matches) {
                const id = e.id ? pc.cyan(e.id) : pc.dim("-");
                const role = pc.dim(e.role ?? "?");
                const label = e.title || e.desc || e.value || "";
                out.println(`  ${role.padEnd(30)} ${id.padEnd(40)} ${label}`);
            }
            if (result.hint) {
                out.println(pc.yellow(`  hint: ${result.hint}`));
            }
        });

    program
        .command("apps")
        .description("List running apps — valid --app values (name, pid, bundleId)")
        .option("--all", "include background/agent processes")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["apps"];
            if (opts.all) {
                axArgs.push("--all");
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
            const apps = (result.apps as Array<Record<string, unknown>>) ?? [];
            out.println(pc.bold(`${apps.length} running apps\n`));
            for (const a of apps) {
                const front = a.frontmost ? pc.green(" frontmost") : "";
                out.println(
                    `  ${pc.cyan(String(a.name ?? "?").padEnd(32))} ${String(a.pid).padEnd(8)} ${pc.dim(String(a.bundleId ?? ""))}${front}`
                );
            }
        });

    program
        .command("window")
        .description("Get window bounds/state — or mutate with --action move|resize|minimize|maximize|close|focus")
        .requiredOption("--app <name>", "app process name")
        .option(
            "--action <action>",
            "move (needs --x --y) | resize (needs --width --height) | minimize | maximize | close | focus"
        )
        .option("--x <n>", "move: new x (screen points)")
        .option("--y <n>", "move: new y (screen points)")
        .option("--width <n>", "resize: new width (points)")
        .option("--height <n>", "resize: new height (points)")
        .option("--window <title>", "target a specific window by title substring")
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const axArgs = ["window", "--app", opts.app];
            for (const k of ["action", "x", "y", "width", "height", "window"] as const) {
                if (opts[k] != null) {
                    axArgs.push(`--${k}`, String(opts[k]));
                }
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
            if (opts.action) {
                out.println(`${pc.green(String(result.action))} ${pc.cyan(String(result.window ?? opts.app))}`);
                return;
            }
            const windows = (result.windows as Array<Record<string, unknown>>) ?? [];
            out.println(pc.bold(`${opts.app} — ${windows.length} windows\n`));
            for (const w of windows) {
                const title = String(w.title ?? "untitled");
                const pos = `(${w.x ?? "?"},${w.y ?? "?"})`;
                const size = `${w.width ?? "?"}x${w.height ?? "?"}`;
                const flags = [w.minimized ? "minimized" : "", w.fullscreen ? "fullscreen" : ""]
                    .filter(Boolean)
                    .join(" ");
                out.println(`  ${pc.cyan(title.padEnd(30))} ${pos.padEnd(14)} ${size.padEnd(12)} ${pc.dim(flags)}`);
            }
        });

    addTargetOptions(
        program
            .command("attrs")
            .description("List ALL attributes and values of an element")
            .requiredOption("--app <name>", "app process name")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["attrs", "--app", opts.app, ...targetArgs(opts)]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            const attrs = (result.attributes as Record<string, unknown>) ?? {};
            out.println(pc.bold(`${targetLabel(opts, result)} — ${result.count} attributes\n`));
            for (const [k, v] of Object.entries(attrs)) {
                const val = typeof v === "object" ? SafeJSON.stringify(v) : String(v);
                out.println(`  ${pc.dim(k.padEnd(30))} ${val}`);
            }
        });

    addTargetOptions(
        program
            .command("actions")
            .description("List available AX actions on an element")
            .requiredOption("--app <name>", "app process name")
    )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .action((opts) => {
            const result = runAx(["actions", "--app", opts.app, ...targetArgs(opts)]);
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
                return;
            }
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            const actions = (result.actions as Array<Record<string, string>>) ?? [];
            out.println(pc.bold(`${targetLabel(opts, result)} (${result.role ?? "?"}) — ${actions.length} actions\n`));
            for (const a of actions) {
                out.println(`  ${pc.cyan(a.action ?? "?")}  ${pc.dim(a.description ?? "")}`);
            }
        });

    program
        .command("preflight")
        .description(
            "RUN THIS FIRST. One call: screens (scale/origins), frontmost app, windows (phantom strips flagged), elements by role, browser tab, units reminder, suggested plan."
        )
        .requiredOption("--app <name>", "app process name")
        .option("--depth <n>", "max tree depth", "10")
        .option(
            "--wanted <groups>",
            "comma list: screens,frontmost,windows,elements,browser,plan — elements:<Role> = full dump of one role (default: all, elements truncated 15/role)"
        )
        .option("--json", "raw JSON output")
        .option("--pretty", "indent JSON output (default compact)")
        .option("--save <path>", "save suggested plan to file")
        .action((opts) => {
            const axArgs = ["preflight", "--app", opts.app, "--depth", opts.depth];
            if (opts.wanted) {
                axArgs.push("--wanted", opts.wanted);
            }
            const result = runAx(axArgs);
            if (!result.ok) {
                logger.error(String(result.error));
                process.exit(1);
            }
            if (opts.json) {
                out.println(SafeJSON.stringify(result, null, opts.pretty ? 2 : 0));
            } else {
                out.println(pc.bold(`${result.app} (pid ${result.pid})\n`));
                const screens = (result.screens as Array<Record<string, unknown>>) ?? [];
                for (const s of screens) {
                    const pts = s.points as Record<string, number>;
                    const origin = s.originCG as Record<string, number>;
                    out.println(
                        pc.dim(
                            `  screen ${s.index}${s.isPrimary ? " (primary)" : ""}: ${pts.width}x${pts.height}pt @${s.scaleFactor}x originCG(${origin.x},${origin.y})`
                        )
                    );
                }
                const front = result.frontmost as Record<string, unknown> | undefined;
                if (front?.app) {
                    out.println(
                        pc.dim(`  frontmost now: ${front.app} (pid ${front.pid}) — preflight does not activate --app`)
                    );
                }
                const tab = result.browserTab as Record<string, unknown> | undefined;
                if (tab) {
                    out.println(pc.dim(`  active tab: ${tab.title ?? ""} ${tab.url ?? ""}`));
                }
                const wins = (result.windows as Array<Record<string, unknown>>) ?? [];
                for (const w of wins) {
                    out.println(`  ${pc.cyan(String(w.title ?? "?"))} ${w.width}x${w.height} at (${w.x},${w.y})`);
                }
                const phantoms = (result.phantomStrips as Array<Record<string, unknown>>) ?? [];
                if (phantoms.length) {
                    out.println(pc.dim(`  (${phantoms.length} transient/phantom windows hidden)`));
                }
                if (result.totalElements !== undefined) {
                    out.println(`\n  ${result.totalElements} elements, ${result.addressableCount} addressable`);
                    const rc = (result.roleCounts as Record<string, number>) ?? {};
                    const roles = Object.entries(rc)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 6);
                    out.println(`  ${roles.map(([r, n]) => `${r}:${n}`).join("  ")}\n`);
                }
                const grouped = (result.grouped as Record<string, Array<Record<string, string>>>) ?? {};
                const SHOW_ROLES = ["AXButton", "AXTextField", "AXCheckBox", "AXPopUpButton", "AXRadioButton"];
                for (const role of SHOW_ROLES) {
                    const els = grouped[role];
                    if (!els?.length) {
                        continue;
                    }
                    const unique = els.filter(
                        (e, i, a) =>
                            a.findIndex((x) => (x.id ?? x.desc ?? x.title) === (e.id ?? e.desc ?? e.title)) === i
                    );
                    out.println(pc.dim(`  ${role} (${unique.length}):`));
                    for (const e of unique.slice(0, 10)) {
                        out.println(
                            `    ${pc.cyan((e.id ?? e.desc ?? e.title ?? "-").padEnd(35))} ${e.id ? e.desc || e.title || "" : ""}`
                        );
                    }
                }
                if (result.note) {
                    out.println(pc.yellow(`  ${result.note}`));
                }
                out.println(`\n${pc.dim("  Plan contract: tools control run --help")}`);
                out.println(
                    pc.dim(
                        "  Step fields: do, q, id, role, title, desc, subrole, window, value, text, path, keys, action"
                    )
                );
                out.println(pc.dim("  Targeting: --q (universal) or --id / --role / --desc / --subrole (specific)"));
                out.println(pc.dim("  Plan-level: app, restore, delayMs, exact\n"));
                const plan = result.suggestedPlan as { steps?: Array<Record<string, unknown>> };
                if (plan?.steps) {
                    out.println(pc.bold("  Suggested plan:"));
                    for (const s of plan.steps) {
                        const label = s._label ?? s.path ?? s.do;
                        const target = s.id ?? s.q ?? "";
                        out.println(
                            `    ${pc.green(String(s.do).padEnd(12))} ${pc.cyan(String(target).padEnd(35))} ${pc.dim(String(label ?? ""))}`
                        );
                    }
                }
            }
            if (opts.save) {
                const plan = result.suggestedPlan as Record<string, unknown>;
                Bun.write(opts.save, SafeJSON.stringify(plan, null, 2));
                out.println(`\n${pc.green("saved")} plan to ${opts.save}`);
            }
        });
}
