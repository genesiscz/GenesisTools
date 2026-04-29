import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "@app/utils/paths";
import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerFillCommand } from "./commands/fill.js";
import { registerLinkCommand } from "./commands/link-workitems.js";
import { registerTimesheetCommand } from "./commands/timesheet.js";

const program = new Command()
    .name("clarity")
    .description("CA PPM Clarity timesheet management & ADO integration")
    .version("1.0.0");

registerConfigureCommand(program);
registerTimesheetCommand(program);
registerFillCommand(program);
registerLinkCommand(program);

program
    .command("ui")
    .alias("dashboard")
    .description("Launch the Clarity dashboard web UI")
    .action(async () => {
        const uiDir = resolve(import.meta.dirname, "ui");
        const configPath = resolve(uiDir, "vite.config.ts");
        const viteEntry = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");
        const url = "http://localhost:3071";

        if (!existsSync(viteEntry)) {
            console.error(`✗ Could not find vite at ${viteEntry}`);
            console.error(`  Run "bun install" in ${PROJECT_ROOT} first.`);
            process.exit(1);
        }

        if (!existsSync(configPath)) {
            console.error(`✗ Vite config missing: ${configPath}`);
            process.exit(1);
        }

        console.log(`Starting Clarity dashboard at ${url} ...`);
        console.log("(first start can take a few seconds; output below comes from Vite)\n");

        // Spawn vite.js directly via bun rather than relying on node_modules/.bin/vite
        // — on Windows the .bin entry is a .cmd shim that Bun.spawn can fail to resolve
        // silently, leaving the user staring at a frozen terminal.
        const child = spawn(
            "bun",
            ["--bun", viteEntry, "dev", "-c", configPath, "--strictPort"],
            {
                cwd: PROJECT_ROOT,
                stdio: "inherit",
                env: { ...process.env, CLARITY_PROJECT_CWD: process.cwd() },
                shell: process.platform === "win32",
            }
        );

        child.on("error", (err) => {
            console.error(`✗ Failed to start vite: ${err.message}`);
            process.exit(1);
        });

        // Open browser after a short delay
        setTimeout(() => {
            if (process.platform === "darwin") {
                spawn("open", [url], { stdio: "ignore", detached: true }).unref();
            } else if (process.platform === "win32") {
                // `start` parses the first quoted token as a window title — pass an empty
                // title first so URLs with special characters end up as the actual target.
                spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
            } else {
                spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
            }
        }, 2000);

        const exitCode: number = await new Promise((res) => {
            child.on("exit", (code) => res(code ?? 1));
        });

        if (exitCode !== 0) {
            console.error(`\n✗ Vite exited with code ${exitCode}`);
        }

        process.exit(exitCode);
    });

program.parse();
