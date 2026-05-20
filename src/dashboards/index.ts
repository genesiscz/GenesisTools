#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { logger, out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { DASHBOARDS, type DashboardKey } from "@app/utils/ui/dashboards";
import { Command } from "commander";

const ROOT = resolve(import.meta.dirname, "../..");
const TOOLS = resolve(ROOT, "tools");

const TARGETS: ReadonlyArray<{ key: string; args: string[] }> = [
    { key: "youtube-server", args: ["youtube", "server"] },
    { key: "youtube", args: ["youtube", "ui"] },
    { key: "dev-dashboard", args: ["dev-dashboard", "ui"] },
    { key: "clarity", args: ["clarity", "ui"] },
    { key: "shops", args: ["shops", "ui"] },
    { key: "reas", args: ["internal", "reas", "ui"] },
    { key: "claude-history", args: ["claude", "history", "dashboard"] },
    { key: "dashboard", args: ["dashboard"] },
];

function parseExcept(raw: string | undefined): Set<string> {
    if (!raw) {
        return new Set();
    }

    return new Set(
        raw
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
    );
}

function resolveTargets(except: Set<string>): typeof TARGETS {
    return TARGETS.filter((target) => !except.has(target.key));
}

async function execDashboard(args: string[], extra: string[] = []): Promise<number> {
    return new Promise((done) => {
        const child = spawn(TOOLS, [...args, ...extra], {
            cwd: ROOT,
            stdio: "inherit",
            env: { ...process.env, BROWSER: "none" },
        });

        child.on("error", (err) => {
            logger.warn({ err, args: [...args, ...extra] }, "dashboards orchestration spawn failed");
            done(1);
        });

        child.on("exit", (code) => {
            done(code ?? 1);
        });
    });
}

async function runVerb(
    verb: "down" | "up" | "restart" | "status",
    opts: { except?: string; open?: boolean }
): Promise<void> {
    const except = parseExcept(opts.except);
    const targets = resolveTargets(except);

    if (targets.length === 0) {
        out.warn("No dashboards matched (everything excluded?).");
        return;
    }

    if (except.size > 0) {
        out.log.info(`Skipping: ${[...except].join(", ")}`);
    }

    const ordered = verb === "down" ? [...targets].reverse() : targets;
    let failures = 0;

    for (const target of ordered) {
        out.log.step(`${verb} ${target.key}…`);
        const extra: string[] = [verb];

        if ((verb === "up" || verb === "restart") && !opts.open) {
            extra.push("--no-open");
        }

        const code = await execDashboard(target.args, extra);

        if (code !== 0) {
            failures += 1;
            out.warn(`${target.key} ${verb} exited ${code}`);
        }
    }

    if (failures > 0) {
        out.warn(`${failures}/${ordered.length} dashboard ${verb} command(s) failed.`);
    } else {
        out.log.success(`${verb} complete for ${ordered.length} dashboard(s).`);
    }
}

const program = new Command()
    .name("dashboards")
    .description("Orchestrate all GenesisTools web dashboards (down/up/restart/status)");

program
    .command("down")
    .description("Stop all launchd-managed dashboards (UIs first, API servers last)")
    .option("--except <keys>", "comma-separated dashboard keys to skip")
    .action(async (opts: { except?: string }) => {
        await runVerb("down", { except: opts.except });
    });

program
    .command("up")
    .description("Start all dashboards (API servers first)")
    .option("--except <keys>", "comma-separated dashboard keys to skip")
    .option("--open", "auto-open browsers (default: off)")
    .action(async (opts: { except?: string; open?: boolean }) => {
        await runVerb("up", { except: opts.except, open: opts.open ?? false });
    });

program
    .command("restart")
    .description("Restart all dashboards")
    .option("--except <keys>", "comma-separated dashboard keys to skip")
    .option("--open", "auto-open browsers (default: off)")
    .action(async (opts: { except?: string; open?: boolean }) => {
        await runVerb("restart", { except: opts.except, open: opts.open ?? false });
    });

program
    .command("status")
    .description("Print status for each dashboard")
    .option("--except <keys>", "comma-separated dashboard keys to skip")
    .action(async (opts: { except?: string }) => {
        await runVerb("status", { except: opts.except });
    });

program
    .command("list")
    .description("List registered dashboard keys and ports")
    .action(() => {
        const lines = TARGETS.map((target) => {
            const entry = DASHBOARDS[target.key as DashboardKey];
            const port = entry?.port ?? "?";
            return `${target.key.padEnd(16)} :${port}  tools ${target.args.join(" ")}`;
        });

        out.println(lines.join("\n"));
    });

await runTool(program, { tool: "dashboards" }).catch((err: unknown) => {
    logger.error("dashboards orchestration failed", err);
    process.exit(1);
});
