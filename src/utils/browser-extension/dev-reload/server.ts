import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("browser-extension-dev-reload");

/**
 * What changed: `tabs` re-injects the content script into matching tabs (the page stays, a video keeps
 * playing); `runtime` reloads the whole extension.
 */
export type DevReloadTarget = "tabs" | "runtime";

export interface DevReloadServer {
    port: number;
    clients(): number;
    broadcast(target: DevReloadTarget): void;
    stop(): void;
}

/**
 * The WebSocket a dev build's worker subscribes to (`runtime/dev-reload.ts`). Each message names the
 * reload to do. The worker pings every 20 s, which also keeps an MV3 worker alive during a session.
 */
export function startDevReloadServer({ port }: { port: number }): DevReloadServer {
    const clients = new Set<Bun.ServerWebSocket<unknown>>();
    const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch(request, srv) {
            if (srv.upgrade(request)) {
                return undefined;
            }

            return new Response("dev-reload up", { status: 200 });
        },
        websocket: {
            open(ws) {
                clients.add(ws);
                log.info({ clients: clients.size }, "extension worker connected");
            },
            close(ws) {
                clients.delete(ws);
                log.info({ clients: clients.size }, "extension worker disconnected");
            },
            message() {
                // Only keepalive pings arrive; there is nothing to answer.
            },
        },
    });

    return {
        port: server.port ?? port,
        clients: () => clients.size,
        broadcast(target) {
            for (const ws of clients) {
                try {
                    ws.send(target);
                } catch (error) {
                    // A dead socket stays dead: drop it so the client count stays honest.
                    clients.delete(ws);
                    log.warn({ error, target }, "dev-reload send failed, dropping the client");
                }
            }
        },
        stop: () => server.stop(true),
    };
}
