import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { logger } from "@app/logger";
import type { Connect } from "vite";

const RELOAD_SNIPPET =
    '<script>(()=>{const es=new EventSource("/__dd_reload");es.onmessage=()=>location.reload();})();</script>';

const reloadClients = new Set<ServerResponse>();

export function notifyPreviewReload(): void {
    for (const client of reloadClients) {
        try {
            client.write("data: reload\n\n");
        } catch (err) {
            reloadClients.delete(client);
            logger.debug({ err }, "preview reload: client write failed");
        }
    }
}

function isIndexRequest(url: string | undefined): boolean {
    if (!url) {
        return false;
    }

    const path = url.split("?")[0] ?? url;

    return path === "/" || path === "/index.html";
}

export function createPreviewReloadSseMiddleware(): Connect.NextHandleFunction {
    return (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
        if (req.url !== "/__dd_reload") {
            next();
            return;
        }

        if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("Method Not Allowed");
            return;
        }

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        reloadClients.add(res);

        req.on("close", () => {
            reloadClients.delete(res);
        });
    };
}

export function createPreviewIndexInjectMiddleware(distDir: string): Connect.NextHandleFunction {
    return (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
        if (req.method !== "GET" || !isIndexRequest(req.url)) {
            next();
            return;
        }

        try {
            const html = readFileSync(join(distDir, "index.html"), "utf8");
            const injected = html.includes(RELOAD_SNIPPET) ? html : html.replace("</head>", `${RELOAD_SNIPPET}</head>`);

            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache");
            res.end(injected);
        } catch (err) {
            logger.warn({ err, distDir }, "preview: failed to serve index.html");
            next();
        }
    };
}
