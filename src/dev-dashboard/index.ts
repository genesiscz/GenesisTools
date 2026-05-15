#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, saveConfig } from "@app/dev-dashboard/config";
import { createBasicAuthCredentials } from "@app/dev-dashboard/lib/auth";
import logger from "@app/logger";
import { PROJECT_ROOT } from "@app/utils/paths";
import { Command } from "commander";

const program = new Command()
    .name("dev-dashboard")
    .description("Personal dev dashboard (ttyd, cmux, obsidian) at mac.foltyn.dev")
    .version("0.1.0");

async function runUiServer(): Promise<void> {
    const uiDir = resolve(import.meta.dirname, "ui");
    const configPath = resolve(uiDir, "vite.config.ts");
    const viteEntry = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

    if (!existsSync(configPath)) {
        console.error(`Could not find dev-dashboard Vite config at ${configPath}`);
        process.exit(1);
    }

    if (!existsSync(viteEntry)) {
        console.error(`Could not find Vite at ${viteEntry}`);
        console.error(`Run "bun install" in ${PROJECT_ROOT} first.`);
        process.exit(1);
    }

    const { port } = await getConfig();
    const url = `http://localhost:${port}`;

    console.log(`Starting dev-dashboard at ${url} ...`);
    console.log("(first start can take a few seconds; output below comes from Vite)\n");

    const child = spawn(
        "bun",
        ["--bun", viteEntry, "dev", "--config", configPath, "--strictPort", "--port", String(port)],
        {
            cwd: PROJECT_ROOT,
            stdio: "inherit",
            env: { ...process.env, FORCE_COLOR: "1", GENESIS_TOOLS_ROOT: PROJECT_ROOT },
            shell: process.platform === "win32",
        }
    );

    child.on("error", (err) => {
        logger.error({ err }, "failed to start Vite");
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

    const exitCode: number = await new Promise((resolveExit) => {
        child.on("exit", (code) => resolveExit(code ?? 1));
    });

    if (exitCode !== 0) {
        console.error(`\nVite exited with code ${exitCode}`);
    }

    process.exit(exitCode);
}

program.action(runUiServer);

program.command("ui").alias("dashboard").description("Launch the dev-dashboard web UI").action(runUiServer);

const auth = program.command("auth").description("Manage dev-dashboard Basic Auth");

auth.command("reset")
    .description("Reset the Basic Auth username/password")
    .option("--username <username>", "Basic Auth username", "martin")
    .option("--password <password>", "Basic Auth password; generated when omitted")
    .action(async (options: { username: string; password?: string }) => {
        const config = await getConfig();
        const { auth: nextAuth, password } = createBasicAuthCredentials({
            username: options.username,
            password: options.password,
        });
        await saveConfig({ ...config, auth: nextAuth });

        console.log("dev-dashboard Basic Auth updated");
        console.log(`username: ${nextAuth.username}`);
        console.log(`password: ${password}`);
    });

program.parseAsync().catch((err) => {
    logger.error({ err }, "dev-dashboard failed");
    process.exit(1);
});
