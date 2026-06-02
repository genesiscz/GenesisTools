#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { defineDashboardApp } from "@app/utils/DashboardApp";
import { Command } from "commander";
import pc from "picocolors";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(TOOL_DIR, "../../DevDashboard/cloud/web");
const NODE_MODULES = join(WEB_DIR, "node_modules");
const DEFAULT_PORT = 7251;

function runToCompletion(cmd: string, args: string[], cwd: string): Promise<number> {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    return new Promise((res) => child.on("exit", (code) => res(code ?? 1)));
}

async function nativeDepsHealthy(): Promise<boolean> {
    const sqlitePath = join(NODE_MODULES, "better-sqlite3");

    if (!existsSync(sqlitePath)) {
        return true;
    }

    const proc = Bun.spawn(["node", "-e", "require('better-sqlite3')(':memory:').close()"], {
        cwd: WEB_DIR,
        stdout: "ignore",
        stderr: "pipe",
    });
    const code = await proc.exited;

    return code === 0;
}

async function rebuildNativeDeps(): Promise<void> {
    logger.info(pc.cyan(`▶ Rebuilding native modules — ${pc.bold("bun rebuild better-sqlite3")} (cloud/web)`));
    const code = await runToCompletion("bun", ["rebuild", "better-sqlite3"], WEB_DIR);

    if (code !== 0) {
        logger.error(`bun rebuild failed (exit ${code}).`);
        process.exit(code);
    }

    if (!(await nativeDepsHealthy())) {
        logger.error(
            "better-sqlite3 still fails to load after rebuild — native ABI may not match this runtime. Try: cd DevDashboard/cloud/web && bun rebuild better-sqlite3"
        );
        process.exit(1);
    }

    logger.info(pc.green("✓ Native modules ready"));
}

async function ensureDeps(install: boolean, reinstall: boolean): Promise<void> {
    const present = existsSync(NODE_MODULES);

    if (present && !reinstall) {
        if (!(await nativeDepsHealthy())) {
            await rebuildNativeDeps();
        }

        return;
    }

    if (!present && !install) {
        logger.error(
            `DevDashboard/cloud/web/node_modules is missing and --no-install was passed. Run ${pc.bold(
                "bun install"
            )} in DevDashboard/cloud/web first.`
        );
        process.exit(1);
    }

    logger.info(
        pc.cyan(
            `▶ ${reinstall ? "Reinstalling" : "Installing"} cloud-web dependencies — ${pc.bold(
                "bun install"
            )} (DevDashboard/cloud/web)`
        )
    );
    const code = await runToCompletion("bun", ["install"], WEB_DIR);

    if (code !== 0) {
        logger.error(`bun install failed (exit ${code}).`);
        process.exit(code);
    }

    if (!(await nativeDepsHealthy())) {
        await rebuildNativeDeps();
    }

    logger.info(pc.green("✓ Dependencies ready"));
}

const cloudApp = defineDashboardApp({
    type: "ui",
    key: "dev-dashboard-cloud",
    name: "DevDashboard Cloud",
    description: "Managed-tier landing + signup + customer dashboard",
    commandName: "dev-dashboard-cloud",
    aliases: ["dd-cloud"],
    port: DEFAULT_PORT,
    spawn: {
        cmd: ["bun", "run", "dev"],
        cwd: WEB_DIR,
    },
    preflight: async () => {
        if (!existsSync(NODE_MODULES)) {
            return {
                warnings: [
                    {
                        service: "dev-dashboard-cloud",
                        error: "DevDashboard/cloud/web/node_modules is missing.",
                        fix: `Run ${pc.bold("bun install")} in DevDashboard/cloud/web, or use bare \`tools dev-dashboard-cloud\` to auto-install.`,
                    },
                ],
            };
        }

        if (!(await nativeDepsHealthy())) {
            await rebuildNativeDeps();
        }

        return { warnings: [] };
    },
    readiness: { kind: "http", path: "/" },
    openBrowser: { enabled: true },
    launchd: { available: true },
});

const program = new Command();

program
    .name("tools dev-dashboard-cloud")
    .description("Start DevDashboard Cloud (managed-tier landing + signup + customer dashboard) and open it")
    .option("--no-open", "do not auto-open the browser")
    .option("--no-install", "do not auto-install when node_modules is missing")
    .option("--reinstall", "force a fresh bun install before starting", false)
    .option("-p, --port <number>", "port to wait on / open", String(DEFAULT_PORT))
    .action(async (opts: { open: boolean; install: boolean; reinstall: boolean; port: string }) => {
        const port = Number.parseInt(opts.port, 10);

        if (Number.isNaN(port)) {
            logger.error(`Invalid --port "${opts.port}".`);
            process.exit(1);
        }

        await ensureDeps(opts.install, opts.reinstall);
        await cloudApp.up({ open: opts.open, port });
    });

for (const sub of cloudApp.commanderCommand.commands) {
    program.addCommand(sub);
}

await runTool(program, { tool: "dev-dashboard-cloud" }).catch((err: unknown) => {
    logger.error({ err }, "dev-dashboard-cloud launcher failed");
    process.exit(1);
});
