import { resolve } from "node:path";
import { getConfig } from "@app/dev-dashboard/config";
import { resolveDevDashboardBindHost } from "@app/dev-dashboard/lib/bind-host";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";
import { staticBuildDir, stopUiServerOnPort } from "@genesiscz/utils/DashboardApp";
import {
    buildPreviewServerWatchGlobs,
    notifyPreviewReload,
    runDashboardPreviewUiServer,
} from "@genesiscz/utils/DashboardApp/preview";
import { findFreePort } from "@genesiscz/utils/net/free-port";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";

export async function runPreviewUiServer(opts: { serve?: "preview" | "static" } = {}): Promise<void> {
    const devDashboardRoot = resolve(import.meta.dirname, "..");
    const uiDir = resolve(devDashboardRoot, "ui");

    await runDashboardPreviewUiServer({
        toolLabel: "dev-dashboard",
        serve: opts.serve,
        staticOutDir: staticBuildDir("dev-dashboard"),
        resolveBindHost: resolveDevDashboardBindHost,
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
