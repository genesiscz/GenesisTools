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

    addTargetOptions(
        program
            .command("actions")
            .description("List available AX actions on an element")
            .requiredOption("--app <name>", "app process name")
    )
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
