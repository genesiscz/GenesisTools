import { resolve } from "node:path";
import { getConfig } from "@app/dev-dashboard/config";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";
import { stopUiServerOnPort } from "@app/utils/DashboardApp";
import {
    buildPreviewServerWatchGlobs,
    notifyPreviewReload,
    runDashboardPreviewUiServer,
} from "@app/utils/DashboardApp/preview";
import { findFreePort } from "@app/utils/net/free-port";
import { PROJECT_ROOT } from "@app/utils/paths";

export async function runPreviewUiServer(): Promise<void> {
    const devDashboardRoot = resolve(import.meta.dirname, "..");
    const uiDir = resolve(devDashboardRoot, "ui");

    await runDashboardPreviewUiServer({
        toolLabel: "dev-dashboard",
        viteConfigPath: resolve(uiDir, "vite.config.ts"),
        configRoot: PROJECT_ROOT,
        uiDir,
        resolvePublicPort: async () => (await getConfig()).port,
        resolveInternalPort: findFreePort,
        beforeListen: (publicPort) => stopUiServerOnPort(publicPort, { commandMatch: "dev-dashboard" }),
        startPublicProxy: ({ publicPort, internalPort, bindHost }) =>
            startFrontProxy({ publicPort, internalPort, hostname: bindHost }),
        onClientRebuild: notifyPreviewReload,
        serverWatchGlobs: buildPreviewServerWatchGlobs({
            toolRoot: devDashboardRoot,
            uiDir,
            previewReloadPath: resolve(PROJECT_ROOT, "src/utils/DashboardApp/preview/reload.ts"),
            toolConfigPath: resolve(devDashboardRoot, "config.ts"),
            extraGlobs: [resolve(PROJECT_ROOT, "src/utils/macos")],
        }),
    });
}
