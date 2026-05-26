import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildViteDevCmd, defineDashboardApp } from "@app/utils/DashboardApp";
import { PROJECT_ROOT } from "@app/utils/paths";
import { DASHBOARDS } from "@app/utils/ui/dashboards";
import { logDashboardApp } from "./log-dashboard-app";

const DASHBOARD_ROOT = resolve(import.meta.dirname, "..", "dashboard");
const VITE_CONFIG = resolve(DASHBOARD_ROOT, "vite.config.ts");
const VITE_ENTRY = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

const uiEntry = DASHBOARDS["debugging-master-ui"];

function preflight(): { ok: boolean; error?: string } {
    if (!existsSync(VITE_ENTRY)) {
        return {
            ok: false,
            error: `Could not find vite at ${VITE_ENTRY}. Run "bun install" in ${PROJECT_ROOT} first.`,
        };
    }

    if (!existsSync(VITE_CONFIG)) {
        return { ok: false, error: `Vite config missing: ${VITE_CONFIG}` };
    }

    return { ok: true };
}

export const logDashboardUiApp = defineDashboardApp({
    type: "ui",
    key: "debugging-master-ui",
    name: uiEntry.name,
    description: "Vite dev server for the log dashboard (HMR; proxies API to the serve backend)",
    commandName: "ui",
    bindHost: uiEntry.bindHost,
    spawn: {
        cmd: buildViteDevCmd({
            configPath: VITE_CONFIG,
            port: uiEntry.port,
            strictPort: uiEntry.strictPort,
            bindHost: uiEntry.bindHost,
        }),
        cwd: PROJECT_ROOT,
        env: {
            LOG_DASHBOARD_PORT: String(DASHBOARDS["debugging-master"].port),
        },
    },
    dependencies: [{ app: logDashboardApp, policy: "auto" }],
    preflight: async () => {
        const check = preflight();
        if (check.ok) {
            return { warnings: [] };
        }

        return { warnings: [{ service: "debugging-master-ui", error: check.error ?? "preflight failed" }] };
    },
    readiness: { kind: "http", path: "/" },
    openBrowser: { enabled: true },
    access: {
        qr: { small: true },
        label: "dashboard dev",
    },
});
