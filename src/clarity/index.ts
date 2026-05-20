import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { defineDashboardApp } from "@app/utils/DashboardApp";
import { PROJECT_ROOT } from "@app/utils/paths";
import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerFillCommand } from "./commands/fill.js";
import { registerLinkCommand } from "./commands/link-workitems.js";
import { registerTimesheetCommand } from "./commands/timesheet.js";
import { runClarityPreflight } from "./lib/preflight.js";

const program = new Command()
    .name("clarity")
    .description("CA PPM Clarity timesheet management & ADO integration")
    .version("1.0.0");

registerConfigureCommand(program);
registerTimesheetCommand(program);
registerFillCommand(program);
registerLinkCommand(program);

const uiDir = resolve(import.meta.dirname, "ui");
const configPath = resolve(uiDir, "vite.config.ts");
const viteEntry = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

if (!existsSync(viteEntry)) {
    out.error(`✗ Could not find vite at ${viteEntry}`);
    out.error(`  Run "bun install" in ${PROJECT_ROOT} first.`);
    process.exit(1);
}

if (!existsSync(configPath)) {
    out.error(`✗ Vite config missing: ${configPath}`);
    process.exit(1);
}

const clarityUi = defineDashboardApp({
    type: "ui",
    key: "clarity",
    name: "Clarity Timelog",
    description: "Launch the Clarity dashboard web UI",
    commandName: "ui",
    aliases: ["dashboard"],
    spawn: {
        cmd: ["bun", "--bun", viteEntry, "dev", "-c", configPath, "--strictPort"],
        cwd: PROJECT_ROOT,
        env: { CLARITY_PROJECT_CWD: process.cwd() },
    },
    preflight: async () => {
        const { failures } = await runClarityPreflight();
        return { warnings: failures };
    },
    readiness: { kind: "http", path: "/" },
    openBrowser: { enabled: true },
    launchd: { available: true },
});

program.addCommand(clarityUi.commanderCommand);

await runTool(program, { tool: "clarity" });
