import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { withRequestContext } from "@app/youtube/lib/request-context";
import {
    extractBearerToken,
    requireServiceKey,
    resolveServiceKeys,
    resolveUser,
    USER_TOKEN_PREFIX,
} from "@app/youtube/lib/server/auth";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { clearPid, registerSignalHandlers, writePid } from "@app/youtube/lib/server/daemon";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { clearPortFile, writePortFile } from "@app/youtube/lib/server/port-file";
import { handleCacheRoute } from "@app/youtube/lib/server/routes/cache";
import { handleChannelsRoute } from "@app/youtube/lib/server/routes/channels";
import { handleCollectionsRoute } from "@app/youtube/lib/server/routes/collections";
import { handleConfigRoute } from "@app/youtube/lib/server/routes/config";
import { handleModelsRoute } from "@app/youtube/lib/server/routes/models";
import { handlePipelineRoute } from "@app/youtube/lib/server/routes/pipeline";
import { handleReportsRoute } from "@app/youtube/lib/server/routes/reports";
import { handleMetaRoute } from "@app/youtube/lib/server/routes/server-meta";
import { handleSharePageRoute } from "@app/youtube/lib/server/routes/share-page";
import { handleSharesRoute } from "@app/youtube/lib/server/routes/shares";
import { handleUsersRoute } from "@app/youtube/lib/server/routes/users";
import { handleVideosRoute } from "@app/youtube/lib/server/routes/videos";
import { handleWebhooksRoute } from "@app/youtube/lib/server/routes/webhooks";
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
    // Crash recovery: holds left "held" by a previous process (killed or
    // redeployed mid-LLM-call) can never be resolved — refund them before
    // serving. Safe here because no requests are in flight yet.
    const staleHolds = youtube.db.releaseStaleHolds();

    if (staleHolds > 0) {
        logger.warn({ staleHolds }, "released orphaned credit holds from a previous run");
    }

    if (opts.startPipeline !== false) {
        await youtube.pipeline.start();
    }

    const configuredPort = await youtube.config.get("apiPort");
    const port = opts.port ?? configuredPort;
    const hostname = env.youtube.getHost();
    const serviceKeys = resolveServiceKeys(env.youtube.getServiceKey());

    if (serviceKeys.length > 0) {
        logger.info({ keyCount: serviceKeys.length }, "youtube API server: service-key auth enabled");
    }

    const websocket = setupWebsocket(youtube);
    const server = Bun.serve<WebsocketState>({
        port,
        hostname,
        websocket: websocket.handler,
        async fetch(req: Request, server): Promise<Response | undefined> {
            try {
                const url = new URL(req.url);

                if (req.method === "OPTIONS") {
                    return new Response(null, { status: 204, headers: CORS_HEADERS });
                }

                // Public share pages: no /api prefix, no auth of any kind (not
                // even the open-route service-key exemption below — this is a
                // plain public webpage, not a JSON API route). Checked first so
                // it never falls into the /api/v1/* dispatch or auth gate.
                if (url.pathname.startsWith("/share/")) {
                    const sharePage = handleSharePageRoute(req, url, youtube);

                    if (sharePage) {
                        return sharePage;
                    }
                }

                // Meta routes (liveness + public discovery) stay open so health
                // checks and readiness probes work without a key. Webhooks stay
                // open too — Stripe can't present our service key; it
                // authenticates via its own request signature instead.
                const isOpenRoute =
                    url.pathname === "/api/v1/healthz" ||
                    url.pathname === "/api/v1/version" ||
                    url.pathname === "/api/v1/openapi.json" ||
                    url.pathname.startsWith("/api/v1/webhooks/");

                if (!isOpenRoute) {
                    const authError = requireServiceKey(req, serviceKeys, youtube.db);

                    if (authError) {
                        return authError;
                    }
                }

                if (url.pathname === "/api/v1/events") {
                    // Scope the socket at upgrade time: a ytu_ token pins it to
                    // that user's jobs; service key / open mode stays operator-wide.
                    const presented =
                        extractBearerToken(req) ??
                        url.searchParams.get("access_token") ??
                        url.searchParams.get("token");
                    const wsUser = presented?.startsWith(USER_TOKEN_PREFIX)
                        ? youtube.db.getUserByToken(presented)
                        : null;
                    const data: WebsocketState = wsUser
                        ? { subscribedJobIds: "all", scope: "user", userId: wsUser.id }
                        : { subscribedJobIds: "all", scope: "all", userId: null };

                    if (server.upgrade(req, { data })) {
                        return undefined;
                    }

                    return new Response(SafeJSON.stringify({ error: "expected websocket" }, { strict: true }), {
                        status: 426,
                        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                    });
                }

                const viewer = resolveUser(req, url, youtube.db);

                return await withRequestContext({ userId: viewer?.id ?? null, db: youtube.db }, () =>
                    dispatchApiRoute(req, url, youtube)
                );
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

    logger.info({ port: serverPort, hostname }, "youtube API server listening");

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

async function dispatchApiRoute(req: Request, url: URL, youtube: Youtube): Promise<Response> {
    if (url.pathname.startsWith("/api/v1/channels")) {
        return handleChannelsRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/videos")) {
        return handleVideosRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/users")) {
        return handleUsersRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/shares")) {
        return handleSharesRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/webhooks")) {
        return handleWebhooksRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/reports")) {
        return handleReportsRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/pipeline") || url.pathname.startsWith("/api/v1/jobs")) {
        return handlePipelineRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/collections")) {
        return handleCollectionsRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/cache")) {
        return handleCacheRoute(req, url, youtube);
    }

    if (url.pathname.startsWith("/api/v1/config")) {
        return handleConfigRoute(req, url, youtube);
    }

    if (url.pathname === "/api/v1/models") {
        return handleModelsRoute(req, url, youtube);
    }

    if (
        url.pathname === "/api/v1/healthz" ||
        url.pathname === "/api/v1/version" ||
        url.pathname === "/api/v1/openapi.json"
    ) {
        return handleMetaRoute(req, url, { startedAt: STARTED_AT });
    }

    return new Response(SafeJSON.stringify({ error: "not found" }, { strict: true }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

if (import.meta.main) {
    const portFlagIndex = process.argv.indexOf("--port");
    const rawPort = portFlagIndex >= 0 ? process.argv[portFlagIndex + 1] : env.node.getPort();
    const parsedPort = rawPort ? parseInt(rawPort, 10) : undefined;
    const port = parsedPort && !Number.isNaN(parsedPort) ? parsedPort : undefined;
    await startServer({ port, daemon: true });
}
