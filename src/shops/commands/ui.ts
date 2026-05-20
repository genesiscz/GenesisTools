import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineDashboardApp } from "@app/utils/DashboardApp";
import { PROJECT_ROOT } from "@app/utils/paths";
import type { Command } from "commander";

const UI_DIR = resolve(import.meta.dirname, "..", "ui");
const CONFIG_PATH = resolve(UI_DIR, "vite.config.ts");
const VITE_ENTRY = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

function preflight(): { ok: boolean; error?: string } {
    if (!existsSync(VITE_ENTRY)) {
        return {
            ok: false,
            error: `Could not find vite at ${VITE_ENTRY}. Run "bun install" in ${PROJECT_ROOT} first.`,
        };
    }
    if (!existsSync(CONFIG_PATH)) {
        return { ok: false, error: `Vite config missing: ${CONFIG_PATH}` };
    }
    return { ok: true };
}

export const shopsUiApp = defineDashboardApp({
    type: "ui",
    key: "shops",
    name: "Shops CZ",
    description: "Launch the Shops dashboard web UI",
    commandName: "ui",
    aliases: ["dashboard"],
    spawn: {
        cmd: ["bun", "--bun", VITE_ENTRY, "dev", "-c", CONFIG_PATH, "--strictPort"],
        cwd: PROJECT_ROOT,
        env: { SHOPS_PROJECT_CWD: process.cwd() },
    },
    preflight: async () => {
        const check = preflight();
        if (check.ok) {
            return { warnings: [] };
        }
        return { warnings: [{ service: "shops", error: check.error ?? "preflight failed" }] };
    },
    readiness: { kind: "http", path: "/" },
    openBrowser: { enabled: true },
    launchd: { available: true },
});

export function registerUiCommand(program: Command): void {
    program.addCommand(shopsUiApp.commanderCommand);
}
