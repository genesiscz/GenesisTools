import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "@app/utils/paths";
import type { Command } from "commander";

export function registerUiCommand(program: Command): void {
    program
        .command("ui")
        .alias("dashboard")
        .description("Launch the Shops dashboard web UI on http://localhost:3073")
        .action(async () => {
            const uiDir = resolve(import.meta.dirname, "..", "ui");
            const configPath = resolve(uiDir, "vite.config.ts");
            const viteEntry = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");
            const url = "http://localhost:3073";

            if (!existsSync(viteEntry)) {
                console.error(`✗ Could not find vite at ${viteEntry}`);
                console.error(`  Run "bun install" in ${PROJECT_ROOT} first.`);
                process.exit(1);
            }

            if (!existsSync(configPath)) {
                console.error(`✗ Vite config missing: ${configPath}`);
                process.exit(1);
            }

            console.log(`Starting Shops dashboard at ${url} ...`);
            console.log("(first start can take a few seconds; output below comes from Vite)\n");

            const child = spawn("bun", ["--bun", viteEntry, "dev", "-c", configPath, "--strictPort"], {
                cwd: PROJECT_ROOT,
                stdio: "inherit",
                env: { ...process.env, SHOPS_PROJECT_CWD: process.cwd() },
                shell: process.platform === "win32",
            });

            child.on("error", (err) => {
                console.error(`✗ Failed to start vite: ${err.message}`);
                process.exit(1);
            });

            setTimeout(() => {
                if (process.platform === "darwin") {
                    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
                } else if (process.platform === "win32") {
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
}
