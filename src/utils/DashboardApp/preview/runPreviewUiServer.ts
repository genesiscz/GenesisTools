import { resolve } from "node:path";
import { logger, out } from "@app/logger";
import { PROJECT_ROOT } from "@app/utils/paths";
import type { RolldownWatcher } from "rolldown";
import type { InlineConfig } from "vite";
import { build, loadConfigFromFile, mergeConfig, preview } from "vite";
import { waitForUrlReady } from "../readiness";
import type { DashboardBindHost } from "../types";
import { openBrowserWhenDashboardEnv } from "./openBrowserWhenEnv";
import { watchPreviewServerFiles } from "./serverHot";
import type { DashboardPreviewPublicProxy, DashboardPreviewUiOptions } from "./types";

function resolveBindHost(opts: DashboardPreviewUiOptions): DashboardBindHost {
    if (opts.resolveBindHost) {
        return opts.resolveBindHost();
    }

    const env = process.env.DASHBOARD_BIND_HOST;

    if (env === "0.0.0.0" || env === "127.0.0.1") {
        return env;
    }

    return "0.0.0.0";
}

export async function runDashboardPreviewUiServer(opts: DashboardPreviewUiOptions): Promise<void> {
    const configRoot = opts.configRoot ?? PROJECT_ROOT;
    const publicPort = await opts.resolvePublicPort();
    const internalPort = await opts.resolveInternalPort();
    const url = opts.publicUrl?.(publicPort) ?? `http://localhost:${publicPort}`;
    const uiDir = opts.uiDir ?? resolve(opts.viteConfigPath, "..");

    if (opts.beforeListen) {
        await opts.beforeListen(publicPort);
    }

    out.println(`Starting ${opts.toolLabel} preview at ${url} ...`);
    out.println("(bundled UI — client rebuilds on save; API/middleware files restart preview automatically)\n");

    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, opts.viteConfigPath, configRoot);

    if (!loaded) {
        out.error(`Could not load Vite config at ${opts.viteConfigPath}`);
        process.exit(1);
    }

    const viteConfig: InlineConfig = {
        ...loaded.config,
        configFile: opts.viteConfigPath,
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
    let publicProxy: DashboardPreviewPublicProxy | undefined;
    let buildWatcher: RolldownWatcher | undefined;
    let stopServerWatch: (() => void) | undefined;
    let restartingPreview = false;

    const closePreview = async () => {
        if (previewServer) {
            await previewServer.close();
            previewServer = undefined;
        }
    };

    const stopPublicProxy = () => {
        if (!publicProxy) {
            return;
        }

        try {
            publicProxy.stop(true);
        } catch (err) {
            logger.debug({ err }, "preview: public proxy stop failed (already stopped?)");
        }

        publicProxy = undefined;
    };

    const startPreviewServer = async () => {
        previewServer = await preview(
            mergeConfig(viteConfig, {
                preview: {
                    port: internalPort,
                    host: "127.0.0.1",
                    strictPort: true,
                },
            })
        );
    };

    const restartPreviewForServerChange = async () => {
        if (restartingPreview) {
            return;
        }

        restartingPreview = true;

        try {
            logger.info("preview: restarting Vite preview after server/API file change");
            await closePreview();
            await startPreviewServer();
            const ready = await waitForUrlReady(`http://127.0.0.1:${internalPort}/`, 30_000);

            if (!ready.ready) {
                logger.warn({ detail: ready.detail }, "preview: API server slow after restart");
            }
        } catch (err) {
            logger.error({ err }, "preview: failed to restart Vite preview");
        } finally {
            restartingPreview = false;
        }
    };

    const shutdown = async (signal: NodeJS.Signals) => {
        stopServerWatch?.();
        stopPublicProxy();
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

        await new Promise<void>((resolvePromise, reject) => {
            initialWatcher.on("event", (event: { code: string; error?: Error }) => {
                if (event.code === "END") {
                    resolvePromise();
                }

                if (event.code === "ERROR") {
                    reject(event.error ?? new Error("Initial preview build failed"));
                }
            });
        });

        await startPreviewServer();

        const activeWatcher = buildWatcher;

        activeWatcher.on("event", (event: { code: string; error?: Error }) => {
            if (event.code === "BUNDLE_END") {
                logger.info("preview: rebuild complete — reloading browsers");
                opts.onClientRebuild?.();
            }

            if (event.code === "ERROR") {
                logger.error({ err: event.error }, "preview: rebuild failed");
            }
        });

        stopServerWatch = watchPreviewServerFiles({
            globs: opts.serverWatchGlobs,
            onChange: restartPreviewForServerChange,
        });

        const bindHost = resolveBindHost(opts);
        const internalUrl = `http://127.0.0.1:${internalPort}/`;
        const previewReady = await waitForUrlReady(internalUrl, 30_000);

        if (!previewReady.ready) {
            logger.error({ internalUrl, detail: previewReady.detail }, "preview server did not become ready");
            process.exit(1);
        }

        const proxy = opts.startPublicProxy({ publicPort, internalPort, bindHost });

        if (proxy) {
            publicProxy = proxy;
        }

        logger.info({ publicPort, internalPort, uiDir }, `${opts.toolLabel} preview mode listening`);

        out.log.success(`Preview ready at ${url}`);
        out.println(
            "Edit UI under ui/src — saves rebuild the bundle. Edit API/middleware — preview restarts automatically."
        );

        await openBrowserWhenDashboardEnv(url);

        await new Promise<void>(() => {
            // keep process alive until signal
        });
    } catch (err) {
        logger.error({ err }, `${opts.toolLabel} preview-ui-server failed`);
        stopServerWatch?.();
        stopPublicProxy();
        buildWatcher?.close();
        await closePreview();
        process.exit(1);
    }
}
