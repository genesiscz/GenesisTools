import { resolve } from "node:path";
import { getConfig } from "@app/dev-dashboard/config";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";
import { stopUiServerOnPort } from "@app/dev-dashboard/lib/stop-ui-server";
import { findFreePort } from "@app/dev-dashboard/lib/ttyd/free-port";
import { notifyPreviewReload } from "@app/dev-dashboard/ui/preview-reload";
import { logger, out } from "@app/logger";
import { waitForUrlReady } from "@app/utils/DashboardApp/readiness";
import { PROJECT_ROOT } from "@app/utils/paths";
import type { RolldownWatcher } from "rolldown";
import { build, loadConfigFromFile, mergeConfig, preview } from "vite";

export async function runPreviewUiServer(): Promise<void> {
    const uiDir = resolve(import.meta.dirname, "../ui");
    const configPath = resolve(uiDir, "vite.config.ts");
    const distDir = resolve(uiDir, "dist");
    const { port } = await getConfig();
    const url = `http://localhost:${port}`;

    stopUiServerOnPort(port);

    const internalPort = await findFreePort();

    out.println(`Starting dev-dashboard preview at ${url} ...`);
    out.println("(bundled UI — rebuilds on save, full page reload; best over Cloudflare tunnel)\n");

    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, configPath, PROJECT_ROOT);

    if (!loaded) {
        out.error(`Could not load Vite config at ${configPath}`);
        process.exit(1);
    }

    const viteConfig = {
        ...loaded.config,
        configFile: configPath,
        root: loaded.config.root ?? uiDir,
        build: {
            ...loaded.config.build,
            watch: {},
        },
        preview: {
            ...loaded.config.preview,
            port: internalPort,
            host: "127.0.0.1",
            strictPort: true,
        },
    };

    let previewServer: Awaited<ReturnType<typeof preview>> | undefined;
    let frontProxy: ReturnType<typeof startFrontProxy> | undefined;
    let buildWatcher: RolldownWatcher | undefined;

    const closePreview = async () => {
        if (previewServer) {
            await previewServer.close();
            previewServer = undefined;
        }
    };

    const stopFrontProxy = () => {
        if (!frontProxy) {
            return;
        }

        try {
            frontProxy.stop(true);
        } catch (err) {
            logger.debug({ err }, "front proxy stop failed (already stopped?)");
        }

        frontProxy = undefined;
    };

    const shutdown = async (signal: NodeJS.Signals) => {
        stopFrontProxy();
        buildWatcher?.close();
        await closePreview();
        process.exit(signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1);
    };

    process.on("SIGINT", () => {
        void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
        void shutdown("SIGTERM");
    });
    process.on("SIGHUP", () => {
        void shutdown("SIGHUP");
    });

    try {
        out.println("Initial production build...");
        const watcher = await build(viteConfig);

        if (!("on" in watcher)) {
            throw new Error("Expected watch build to return a RolldownWatcher");
        }

        buildWatcher = watcher;
        const initialWatcher = buildWatcher;

        await new Promise<void>((resolve, reject) => {
            initialWatcher.on("event", (event) => {
                if (event.code === "END") {
                    resolve();
                }

                if (event.code === "ERROR") {
                    reject(event.error ?? new Error("Initial preview build failed"));
                }
            });
        });

        previewServer = await preview(
            mergeConfig(viteConfig, {
                preview: {
                    port: internalPort,
                    host: "127.0.0.1",
                    strictPort: true,
                },
            })
        );

        const activeWatcher = buildWatcher;

        activeWatcher.on("event", (event) => {
            if (event.code === "BUNDLE_END") {
                logger.info("preview: rebuild complete — reloading browsers");
                notifyPreviewReload();
            }

            if (event.code === "ERROR") {
                logger.error({ err: event.error }, "preview: rebuild failed");
            }
        });

        const bindHost = process.env.DASHBOARD_BIND_HOST ?? "0.0.0.0";
        const internalUrl = `http://127.0.0.1:${internalPort}/`;
        const previewReady = await waitForUrlReady(internalUrl, 30_000);

        if (!previewReady.ready) {
            logger.error({ internalUrl, detail: previewReady.detail }, "preview server did not become ready");
            process.exit(1);
        }

        frontProxy = startFrontProxy({ publicPort: port, internalPort, hostname: bindHost });
        logger.info({ publicPort: port, internalPort, distDir }, "preview mode listening");

        out.log.success(`Preview ready at ${url}`);
        out.println("Edit UI files as usual — saves trigger a rebuild and browser reload.");

        if (process.env.DASHBOARD_OPEN_BROWSER === "1") {
            const { spawn } = await import("node:child_process");
            const ready = await waitForUrlReady(url, 20_000);

            if (ready.ready) {
                const [cmd, args] =
                    process.platform === "darwin"
                        ? (["open", [url]] as const)
                        : process.platform === "win32"
                          ? (["cmd", ["/c", "start", "", url]] as const)
                          : (["xdg-open", [url]] as const);
                const opener = spawn(cmd, args, { stdio: "ignore", detached: true });
                opener.on("error", (err) => logger.debug({ err, cmd }, "failed to auto-open browser"));
                opener.unref();
            }
        }

        await new Promise<void>(() => {
            // keep process alive until signal
        });
    } catch (err) {
        logger.error({ err }, "preview-ui-server failed");
        stopFrontProxy();
        buildWatcher?.close();
        await closePreview();
        process.exit(1);
    }
}
