#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { logger, out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { Command } from "commander";
import pc from "picocolors";
import { type AxResult, ensureBinary, runAx } from "./lib/runner";

const program = new Command();

program
    .name("ax")
    .description("macOS Accessibility API — interact with native app UI elements by AXIdentifier")
    .version("1.0.0");

program
    .command("list")
    .description("List AX elements in an app (identifiers, roles, values)")
    .requiredOption("--app <name>", "app process name")
    .option("--depth <n>", "max tree depth", "10")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["list", "--app", opts.app, "--depth", opts.depth]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
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

function targetArgs(opts: Record<string, string | undefined>): string[] {
    const a: string[] = [];
    if (opts.q) {
        a.push("--q", opts.q);
    }
    if (opts.id) {
        a.push("--id", opts.id);
    }
    if (opts.role) {
        a.push("--role", opts.role);
    }
    if (opts.title) {
        a.push("--title", opts.title);
    }
    if (opts.desc) {
        a.push("--desc", opts.desc);
    }
    if (opts.subrole) {
        a.push("--subrole", opts.subrole);
    }
    if (opts.window) {
        a.push("--window", opts.window);
    }
    if (opts.exact) {
        a.push("--exact");
    }
    return a;
}

function targetLabel(opts: Record<string, string | undefined>, result: Record<string, unknown>): string {
    return String(result.axId ?? result.desc ?? opts.q ?? opts.id ?? opts.desc ?? opts.title ?? "?");
}

program
    .command("get")
    .description("Read attributes of an element")
    .requiredOption("--app <name>", "app process name")
    .option("--id <axId>", "target by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["get", "--app", opts.app, ...targetArgs(opts)]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
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

program
    .command("set")
    .description("Set value of a text field")
    .requiredOption("--app <name>", "app process name")
    .requiredOption("--value <text>", "value to set")
    .option("--id <axId>", "target by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["set", "--app", opts.app, ...targetArgs(opts), "--value", opts.value]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        out.println(`${pc.green("set")} ${pc.cyan(targetLabel(opts, result))} = ${pc.bold(opts.value)}`);
    });

program
    .command("press")
    .description("Press (AXPress) an element")
    .requiredOption("--app <name>", "app process name")
    .option("--id <axId>", "target by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["press", "--app", opts.app, ...targetArgs(opts)]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        out.println(`${pc.green("pressed")} ${pc.cyan(targetLabel(opts, result))}`);
    });

program
    .command("tree")
    .description("Hierarchical tree dump of AX elements (nested JSON)")
    .requiredOption("--app <name>", "app process name")
    .option("--depth <n>", "max tree depth", "10")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["tree", "--app", opts.app, "--depth", opts.depth]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        out.println(SafeJSON.stringify(result, null, 2));
    });

program
    .command("attrs")
    .description("List ALL attributes and values of an element")
    .requiredOption("--app <name>", "app process name")
    .option("--id <axId>", "target by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["attrs", "--app", opts.app, ...targetArgs(opts)]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
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

program
    .command("actions")
    .description("List available AX actions on an element")
    .requiredOption("--app <name>", "app process name")
    .option("--id <axId>", "target by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["actions", "--app", opts.app, ...targetArgs(opts)]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
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
    .command("perform")
    .description("Perform any AX action on an element (generic version of press)")
    .requiredOption("--app <name>", "app process name")
    .requiredOption("--action <action>", "AX action name (e.g. AXPress, AXShowMenu, AXRaise)")
    .option("--id <axId>", "target by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["perform", "--app", opts.app, ...targetArgs(opts), "--action", opts.action]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        out.println(`${pc.green("performed")} ${pc.cyan(opts.action)} on ${pc.cyan(opts.id)}`);
    });

program
    .command("find")
    .description("Search for elements by role, title, value, or description")
    .requiredOption("--app <name>", "app process name")
    .option("--role <role>", "filter by AXRole (exact match)")
    .option("--title <title>", "filter by AXTitle (substring, case-insensitive)")
    .option("--value <value>", "filter by AXValue (substring, case-insensitive)")
    .option("--desc <desc>", "filter by AXDescription (substring, case-insensitive)")
    .option("--depth <n>", "max search depth", "15")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const axArgs = ["find", "--app", opts.app, "--depth", opts.depth];
        if (opts.role) {
            axArgs.push("--role", opts.role);
        }
        if (opts.title) {
            axArgs.push("--title", opts.title);
        }
        if (opts.value) {
            axArgs.push("--value", opts.value);
        }
        if (opts.desc) {
            axArgs.push("--desc", opts.desc);
        }
        const result = runAx(axArgs);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
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
    });

program
    .command("window")
    .description("Get window bounds, position, and state for an app")
    .requiredOption("--app <name>", "app process name")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["window", "--app", opts.app]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        const windows = (result.windows as Array<Record<string, unknown>>) ?? [];
        out.println(pc.bold(`${opts.app} — ${windows.length} windows\n`));
        for (const w of windows) {
            const title = String(w.title ?? "untitled");
            const pos = `(${w.x ?? "?"},${w.y ?? "?"})`;
            const size = `${w.width ?? "?"}x${w.height ?? "?"}`;
            const flags = [w.minimized ? "minimized" : "", w.fullscreen ? "fullscreen" : ""].filter(Boolean).join(" ");
            out.println(`  ${pc.cyan(title.padEnd(30))} ${pos.padEnd(14)} ${size.padEnd(12)} ${pc.dim(flags)}`);
        }
    });

program
    .command("focus")
    .description("Activate app and optionally focus a specific element")
    .requiredOption("--app <name>", "app process name")
    .option("--id <axId>", "target by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["focus", "--app", opts.app, ...targetArgs(opts)]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        const target = result.axId ?? result.desc ?? result.title ?? opts.app;
        out.println(`${pc.green("focused")} ${pc.cyan(String(target))}`);
    });

program
    .command("click")
    .description("CGEvent click at element center — no coordinates needed")
    .requiredOption("--app <name>", "app process name")
    .option("--id <axId>", "target by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["click", "--app", opts.app, ...targetArgs(opts)]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        const target = result.axId ?? result.desc ?? result.title ?? "?";
        out.println(`${pc.green("clicked")} ${pc.cyan(String(target))} at (${result.x},${result.y})`);
    });

program
    .command("type")
    .description("Type keystrokes into app, optionally focusing an element first")
    .requiredOption("--app <name>", "app process name")
    .requiredOption("--text <text>", "text to type")
    .option("--id <axId>", "target element by AXIdentifier")
    .option("--role <role>", "target by AXRole")
    .option("--title <title>", "target by AXTitle")
    .option("--desc <desc>", "target by AXDescription")
    .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
    .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
    .option("--window <title>", "scope search to window with this title")
    .option("--exact", "force strict role/subrole matching (default is fuzzy)")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["type", "--app", opts.app, "--text", opts.text, ...targetArgs(opts)]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
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
    .command("snapshot")
    .description("Capture current mouse position + focused app/window")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["snapshot"]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        const m = result.mouse as Record<string, number>;
        out.println(
            `${pc.green("snapshot")} app=${pc.cyan(String(result.app))} mouse=(${m?.x?.toFixed(0)},${m?.y?.toFixed(0)})`
        );
        out.println(pc.dim(`  restore with: tools ax restore --snapshot '${SafeJSON.stringify(result)}'`));
    });

program
    .command("restore")
    .description("Restore mouse position + focused app/window from a snapshot")
    .requiredOption("--snapshot <json>", "snapshot JSON from the snapshot command")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["restore", "--snapshot", opts.snapshot]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        out.println(`${pc.green("restored")} app=${pc.cyan(String(result.app))}`);
    });

program
    .command("screenshot")
    .description("Window screenshot via CGWindowList (no peekaboo/bridge)")
    .requiredOption("--app <name>", "app process name")
    .requiredOption("--path <file>", "output PNG path")
    .option("--window <title>", "target specific window by title")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const axArgs = ["screenshot", "--app", opts.app, "--path", opts.path];
        if (opts.window) {
            axArgs.push("--window", opts.window);
        }
        const result = runAx(axArgs);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
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

program
    .command("hotkey")
    .description("Send key combo via CGEvent (no peekaboo/bridge)")
    .requiredOption("--keys <keys>", "comma-separated: cmd,shift,a")
    .option("--json", "raw JSON output")
    .action((opts) => {
        const result = runAx(["hotkey", "--keys", opts.keys]);
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
            return;
        }
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        out.println(`${pc.green("sent")} ${pc.cyan(opts.keys)}`);
    });

program
    .command("preflight")
    .description("Discover app AX surface — windows, elements by role, addressable IDs, suggested plan")
    .requiredOption("--app <name>", "app process name")
    .option("--depth <n>", "max tree depth", "10")
    .option("--json", "raw JSON output")
    .option("--save <path>", "save suggested plan to file")
    .action((opts) => {
        const result = runAx(["preflight", "--app", opts.app, "--depth", opts.depth]);
        if (!result.ok) {
            logger.error(String(result.error));
            process.exit(1);
        }
        if (opts.json) {
            out.println(SafeJSON.stringify(result, null, 2));
        } else {
            out.println(pc.bold(`${result.app} (pid ${result.pid})\n`));
            const wins = (result.windows as Array<Record<string, unknown>>) ?? [];
            for (const w of wins) {
                out.println(`  ${pc.cyan(String(w.title ?? "?"))} ${w.width}x${w.height} at (${w.x},${w.y})`);
            }
            out.println(`\n  ${result.totalElements} elements, ${result.addressableCount} addressable`);
            const rc = (result.roleCounts as Record<string, number>) ?? {};
            const roles = Object.entries(rc)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6);
            out.println(`  ${roles.map(([r, n]) => `${r}:${n}`).join("  ")}\n`);
            const grouped = (result.grouped as Record<string, Array<Record<string, string>>>) ?? {};
            const SHOW_ROLES = ["AXButton", "AXTextField", "AXCheckBox", "AXPopUpButton", "AXRadioButton"];
            for (const role of SHOW_ROLES) {
                const els = grouped[role];
                if (!els?.length) {
                    continue;
                }
                const unique = els.filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
                out.println(pc.dim(`  ${role} (${unique.length}):`));
                for (const e of unique.slice(0, 10)) {
                    out.println(`    ${pc.cyan((e.id ?? "-").padEnd(35))} ${e.desc || e.title || ""}`);
                }
            }
            out.println(`\n${pc.dim("  Plan contract: tools ax run --help")}`);
            out.println(
                pc.dim("  Step fields: do, q, id, role, title, desc, subrole, window, value, text, path, keys, action")
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

const ACTION_ALIASES: Record<string, string> = {
    "ax-set": "set",
    "ax-press": "press",
    "ax-perform": "perform",
    axSet: "set",
    axPress: "press",
    axPerform: "perform",
};

const NO_APP_COMMANDS = new Set(["snapshot", "restore", "hotkey"]);

program
    .command("run <plan>")
    .description(`Execute a plan file — sequential ax-tool commands with snapshot/restore.

  Plan contract (JSON):
    {
      "app":      "Genesis",         // default app for all steps
      "restore":  true,              // snapshot before, restore after
      "delayMs":  300,               // pause between steps (ms, default 200)
      "exact":    false,             // force strict role matching
      "steps": [
        { "do": "focus" },
        { "do": "press", "q": "Chat" },
        { "do": "click", "desc": "Account", "role": "button" },
        { "do": "set", "id": "field-id", "value": "hello" },
        { "do": "type", "q": "field-id", "text": "world" },
        { "do": "screenshot", "path": "/tmp/shot.png" },
        { "do": "hotkey", "keys": "cmd,w" },
        { "do": "click", "subrole": "close", "window": "Settings" }
      ]
    }

  Step fields: do (command), q (universal search), id, role, title, desc,
    subrole, window, value, text, path, keys, action, delay, app (override).
  Action aliases: ax-set/ax-press/ax-perform map to set/press/perform.
  Role/subrole fuzzy by default: "button" matches AXButton.`)
    .option("--json", "raw JSON output")
    .action((planPath, opts) => {
        if (!existsSync(planPath)) {
            logger.error(`plan file not found: ${planPath}`);
            process.exit(1);
        }
        const plan = SafeJSON.parse(readFileSync(planPath, "utf-8")) as {
            app?: string;
            restore?: boolean;
            delayMs?: number;
            exact?: boolean;
            steps: Array<Record<string, unknown>>;
        };
        if (!plan.steps?.length) {
            logger.error("plan has no steps");
            process.exit(1);
        }

        const delay = plan.delayMs ?? 200;
        let snapshot: AxResult | null = null;

        if (plan.restore) {
            snapshot = runAx(["snapshot"]);
        }

        const results: Array<{ step: Record<string, unknown>; result: AxResult; ms: number }> = [];
        for (const step of plan.steps) {
            let cmd = String(step.do ?? "");
            cmd = ACTION_ALIASES[cmd] ?? cmd;
            const app = String(step.app ?? plan.app ?? "");
            if (!cmd) {
                results.push({ step, result: { ok: false, error: "missing 'do'" }, ms: 0 });
                continue;
            }

            const args: string[] = [cmd];
            if (!NO_APP_COMMANDS.has(cmd)) {
                if (!app) {
                    results.push({ step, result: { ok: false, error: "missing 'app'" }, ms: 0 });
                    continue;
                }
                args.push("--app", app);
            }
            for (const [k, v] of Object.entries(step)) {
                if (k === "do" || k === "app" || k === "delay" || v == null) {
                    continue;
                }
                args.push(`--${k}`, String(v));
            }
            if (plan.exact) {
                args.push("--exact");
            }

            const t0 = performance.now();
            const result = runAx(args);
            const ms = Math.round(performance.now() - t0);
            results.push({ step, result, ms });

            if (!opts.json) {
                const label = step.q ?? step.id ?? step.desc ?? step.subrole ?? step.text ?? cmd;
                const status = result.ok ? pc.green("ok") : pc.red("FAIL");
                out.println(`  ${status} ${pc.cyan(String(label))} ${pc.dim(`${ms}ms`)}`);
            }

            const stepDelay = typeof step.delay === "number" ? step.delay : delay;
            if (stepDelay > 0) {
                Bun.sleepSync(stepDelay);
            }
        }

        if (plan.restore && snapshot?.ok) {
            runAx(["restore", "--snapshot", SafeJSON.stringify(snapshot)]);
            if (!opts.json) {
                out.println(`  ${pc.green("restored")} mouse + focus`);
            }
        }

        if (opts.json) {
            out.println(SafeJSON.stringify({ ok: true, steps: results, restored: !!plan.restore }, null, 2));
        } else {
            const passed = results.filter((r) => r.result.ok).length;
            const total = results.length;
            const totalMs = results.reduce((s, r) => s + r.ms, 0);
            out.println(`\n${passed}/${total} steps passed, ${totalMs}ms total`);
        }
    });

program
    .command("build")
    .description("Build/rebuild the native ax-tool binary")
    .action(() => {
        try {
            out.println("Building ax-tool (Swift)...");
            const path = ensureBinary();
            out.println(`${pc.green("built")} ${path}`);
        } catch (e) {
            logger.error(e instanceof Error ? e.message : String(e));
            process.exit(1);
        }
    });

try {
    await runTool(program, { tool: "ax" });
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    process.exit(1);
}
