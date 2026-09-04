import { resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import type { RolldownWatcher } from "rolldown";
import type { InlineConfig } from "vite";
import { build, loadConfigFromFile, mergeConfig, preview } from "vite";
import { waitForUrlReady } from "../readiness";
import type { DashboardBindHost } from "../types";
import { openBrowserWhenDashboardEnv } from "./openBrowserWhenEnv";
import { isPreviewRestarting, setPreviewRestarting } from "./restartState";
import { watchPreviewServerFiles } from "./serverHot";
import type { DashboardPreviewPublicProxy, DashboardPreviewUiOptions } from "./types";

function resolveBindHost(opts: DashboardPreviewUiOptions): DashboardBindHost {
    if (opts.resolveBindHost) {
        return opts.resolveBindHost();
    }

    const bindHost = env.dashboard.getBindHost();

    if (bindHost === "0.0.0.0" || bindHost === "127.0.0.1") {
        return bindHost;
    }

    return "0.0.0.0";
}

export async function runDashboardPreviewUiServer(opts: DashboardPreviewUiOptions): Promise<void> {
    const configRoot = opts.configRoot ?? PROJECT_ROOT;
    const publicPort = await opts.resolvePublicPort();
    let internalPort = await opts.resolveInternalPort();
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
    /** A server/API save seen while a restart was already in flight. */
    let restartPending = false;

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

    const startPreviewServerOn = async (port: number) => {
        return preview(
            mergeConfig(viteConfig, {
                preview: {
                    port,
                    host: "127.0.0.1",
                    strictPort: true,
                },
            })
        );
    };

    const startPreviewServer = async () => {
        previewServer = await startPreviewServerOn(internalPort);
    };

    // Make-before-break. The front proxy reads `internalPort` per request, so the
    // old preview keeps answering until the replacement is proven ready on a fresh
    // port. Closing first (the previous behaviour) left the proxy pointing at a
    // dead port for the whole Vite boot, and every request in that window became a
    // public 502 once the 2.5s upstream retry budget ran out.
    const swapInReplacementPreview = async () => {
        logger.info("preview: restarting Vite preview after server/API file change");
        const nextPort = await opts.resolveInternalPort();
        const nextServer = await startPreviewServerOn(nextPort);
        const ready = await waitForUrlReady(`http://127.0.0.1:${nextPort}/`, 30_000);

        if (!ready.ready) {
            logger.warn(
                { detail: ready.detail, nextPort, internalPort },
                "preview: replacement Vite preview never became ready — keeping the running one"
            );
            await nextServer.close();
            return;
        }

        const previous = previewServer;
        previewServer = nextServer;
        internalPort = nextPort;
        logger.info({ internalPort: nextPort }, "preview: swapped to the replacement Vite preview");
        await previous?.close();
    };

    const restartPreviewForServerChange = async (): Promise<void> => {
        // A save landing inside the restart window used to be dropped outright,
        // and make-before-break made that silent: the swapped-in server kept
        // serving stale code with no later trigger, where the old close-first
        // behaviour at least showed 502s. Remember it and restart once more.
        if (isPreviewRestarting()) {
            restartPending = true;
            return;
        }

        setPreviewRestarting(true);

        try {
            await swapInReplacementPreview();
        } catch (err) {
            logger.error({ err }, "preview: failed to restart Vite preview");
        } finally {
            setPreviewRestarting(false);
        }

        if (restartPending) {
            restartPending = false;
            await restartPreviewForServerChange();
        }
    };

    // Every exit path logs why. Under launchd (KeepAlive) a silent exit is
    // indistinguishable from a crash after the fact: the restart storm that
    // motivated this left 4151 respawns in the log with no recoverable cause.
    const shutdown = async (signal: NodeJS.Signals) => {
        logger.warn({ signal, publicPort, internalPort }, `${opts.toolLabel} preview: signal received, shutting down`);
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
    process.on("uncaughtException", (err) => {
        logger.error({ err, publicPort, internalPort }, `${opts.toolLabel} preview: uncaught exception, exiting`);
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
        logger.error({ err: reason, publicPort, internalPort }, `${opts.toolLabel} preview: unhandled rejection`);
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

        // A slow preview is not a reason to die. Exiting here handed the process
        // straight back to launchd's KeepAlive, which restarted it into the same
        // slow build — a loop that took the public port down far longer than the
        // slow start ever would. The proxy retries its upstream, so bind anyway.
        if (!previewReady.ready) {
            logger.error(
                { internalUrl, detail: previewReady.detail },
                "preview server did not become ready — binding the public proxy anyway"
            );
        }

        const proxy = opts.startPublicProxy({ publicPort, internalPort: () => internalPort, bindHost });

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
