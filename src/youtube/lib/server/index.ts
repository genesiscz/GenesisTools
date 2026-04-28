import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { clearPid, registerSignalHandlers, writePid } from "@app/youtube/lib/server/daemon";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { clearPortFile, writePortFile } from "@app/youtube/lib/server/port-file";
import { handleCacheRoute } from "@app/youtube/lib/server/routes/cache";
import { handleChannelsRoute } from "@app/youtube/lib/server/routes/channels";
import { handleConfigRoute } from "@app/youtube/lib/server/routes/config";
import { handlePipelineRoute } from "@app/youtube/lib/server/routes/pipeline";
import { handleMetaRoute } from "@app/youtube/lib/server/routes/server-meta";
import { handleVideosRoute } from "@app/youtube/lib/server/routes/videos";
import type { WebsocketState } from "@app/youtube/lib/server/websocket";
import { setupWebsocket } from "@app/youtube/lib/server/websocket";
import { Youtube } from "@app/youtube/lib/youtube";

export interface StartServerOptions {
    port?: number;
    baseDir?: string;
    foreground?: boolean;
    daemon?: boolean;
    startPipeline?: boolean;
}

export interface ServerHandle {
    port: number;
    youtube: Youtube;
    stop(): Promise<void>;
}

const STARTED_AT = Date.now();

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
    const youtube = new Youtube({ baseDir: opts.baseDir });

    if (opts.startPipeline !== false) {
        await youtube.pipeline.start();
    }

    const configuredPort = await youtube.config.get("apiPort");
    const port = opts.port ?? configuredPort;
    const websocket = setupWebsocket(youtube);
    const server = Bun.serve<WebsocketState>({
        port,
        websocket: websocket.handler,
        async fetch(req: Request, server): Promise<Response | undefined> {
            try {
                const url = new URL(req.url);

                if (req.method === "OPTIONS") {
                    return new Response(null, { status: 204, headers: CORS_HEADERS });
                }

                if (url.pathname === "/api/v1/events") {
                    if (server.upgrade(req, { data: { subscribedJobIds: "all" } })) {
                        return undefined;
                    }

                    return new Response(SafeJSON.stringify({ error: "expected websocket" }, { strict: true }), {
                        status: 426,
                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                    });
                }

                if (url.pathname.startsWith("/api/v1/channels")) {
                    return await handleChannelsRoute(req, url, youtube);
                }

                if (url.pathname.startsWith("/api/v1/videos")) {
                    return await handleVideosRoute(req, url, youtube);
                }

                if (url.pathname.startsWith("/api/v1/pipeline") || url.pathname.startsWith("/api/v1/jobs")) {
                    return await handlePipelineRoute(req, url, youtube);
                }

                if (url.pathname.startsWith("/api/v1/cache")) {
                    return await handleCacheRoute(req, url, youtube);
                }

                if (url.pathname.startsWith("/api/v1/config")) {
                    return await handleConfigRoute(req, url, youtube);
                }

                if (
                    url.pathname === "/api/v1/healthz" ||
                    url.pathname === "/api/v1/version" ||
                    url.pathname === "/api/v1/openapi.json"
                ) {
                    return await handleMetaRoute(req, url, { startedAt: STARTED_AT });
                }

                return new Response(SafeJSON.stringify({ error: "not found" }, { strict: true }), {
                    status: 404,
                    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                });
            } catch (err) {
                return toErrorResponse(err);
            }
        },
    });

    const serverPort = server.port;

    if (serverPort === undefined) {
        throw new Error("youtube API server failed to bind a port");
    }

    writePortFile({ port: serverPort });

    if (opts.daemon) {
        writePid();
        registerSignalHandlers(async () => {
            websocket.close();
            server.stop();
            await youtube.dispose();
        });
    }

    logger.info({ port: serverPort }, "youtube API server listening");

    return {
        port: serverPort,
        youtube,
        async stop(): Promise<void> {
            websocket.close();
            server.stop();
            await youtube.dispose();
            clearPortFile();
            clearPid();
        },
    };
}

if (import.meta.main) {
    const portFlagIndex = process.argv.indexOf("--port");
    const rawPort = portFlagIndex >= 0 ? process.argv[portFlagIndex + 1] : process.env.PORT;
    const parsedPort = rawPort ? parseInt(rawPort, 10) : undefined;
    const port = parsedPort && !Number.isNaN(parsedPort) ? parsedPort : undefined;
    await startServer({ port, daemon: true });
}
