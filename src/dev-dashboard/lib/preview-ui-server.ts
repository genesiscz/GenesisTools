import { resolve } from "node:path";
import { getConfig } from "@app/dev-dashboard/config";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";
import { stopUiServerOnPort } from "@app/dev-dashboard/lib/stop-ui-server";
import { findFreePort } from "@app/dev-dashboard/lib/ttyd/free-port";
import { notifyPreviewReload } from "@app/dev-dashboard/ui/preview-reload";
import { buildPreviewServerWatchGlobs, runDashboardPreviewUiServer } from "@app/utils/DashboardApp/preview";
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
        beforeListen: stopUiServerOnPort,
        startPublicProxy: ({ publicPort, internalPort, bindHost }) =>
            startFrontProxy({ publicPort, internalPort, hostname: bindHost }),
        onClientRebuild: notifyPreviewReload,
        serverWatchGlobs: buildPreviewServerWatchGlobs({
            toolRoot: devDashboardRoot,
            uiDir,
            previewReloadPath: resolve(uiDir, "preview-reload.ts"),
            toolConfigPath: resolve(devDashboardRoot, "config.ts"),
            extraGlobs: [resolve(PROJECT_ROOT, "src/utils/macos")],
        }),
    });
}
