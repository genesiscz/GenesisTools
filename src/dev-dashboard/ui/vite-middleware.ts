import type { IncomingMessage, ServerResponse } from "node:http";
import { getDashboardAuthCached } from "@app/dev-dashboard/config";
import {
    buildSessionCookie,
    isCompleteAuthConfig,
    issueSessionToken,
    LOCAL_ORIGIN_HEADER,
    verifyBasicAuthHeader,
    verifySessionToken,
} from "@app/dev-dashboard/lib/auth";
import { isPublicShareRequest } from "@app/dev-dashboard/lib/share-auth";
import { handleWithRouter } from "@app/dev-dashboard/server/adapters/node-connect";
import { defaultSystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { createDashboardRouter, startBackgroundServices } from "@app/dev-dashboard/server/registry";
import { logger } from "@app/logger";
import type { Connect } from "vite";

// The route handlers + the cmux/pulse pollers now live in the extracted,
// transport-neutral registry (src/dev-dashboard/server/*). This middleware is a
// thin Connect adapter: it runs the dashboard auth gate, then delegates every
// /api/* + /share/* request to the SAME router the standalone Agent uses
// (src/dev-dashboard/server/adapters/bun-serve.ts), so behavior can never drift
// between the web (Vite) and the Agent transports.

let loggedGeneratedPassword = false;

async function requireDashboardAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (isPublicShareRequest(req.method ?? "GET", url.pathname)) {
        return true;
    }

    // Loopback exemption. The front-proxy sets x-dd-local-origin ONLY for a
    // genuine localhost hit (real loopback socket + localhost Host + no
    // Cloudflare headers) and strips any inbound copy, so this cannot be forged
    // over the tunnel or LAN. Vite binds 127.0.0.1, so only the local
    // front-proxy can reach here to set it.
    if (req.headers[LOCAL_ORIGIN_HEADER] === "1") {
        return true;
    }

    const provision = await getDashboardAuthCached();

    if (provision.generatedPassword && !loggedGeneratedPassword) {
        loggedGeneratedPassword = true;
        logger.warn(
            {
                username: provision.auth.username,
                password: provision.generatedPassword,
            },
            "generated dev-dashboard basic auth password"
        );
    }

    if (!provision.auth.enabled) {
        return true;
    }

    if (!isCompleteAuthConfig(provision.auth)) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Dashboard auth is enabled but no password hash is configured.");
        return false;
    }

    const auth = provision.auth;

    // A valid session cookie authenticates without re-issuing one.
    if (verifySessionToken(req.headers.cookie ?? null, auth)) {
        return true;
    }

    if (verifyBasicAuthHeader(req.headers.authorization ?? null, auth)) {
        // Mint the session cookie so browser-initiated WebSocket handshakes
        // (ttyd terminal + Vite HMR) — which cannot send an Authorization
        // header and are gated by the front-proxy, not this middleware — can
        // authenticate. Secure only over the HTTPS tunnel (Cloudflare sets
        // x-forwarded-proto); plain http://localhost must still receive it.
        const secure = req.headers["x-forwarded-proto"] === "https";
        res.setHeader("Set-Cookie", buildSessionCookie(issueSessionToken(auth), { secure }));
        return true;
    }

    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="GenesisTools dev dashboard", charset="UTF-8"');
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Authentication required.");
    return false;
}

// Built once at module load. The pollers (cmux + pulse) were previously started
// by inline `getConfig().then(...)` blocks here; that lifecycle now lives in
// startBackgroundServices() so the Agent and the web share one boot path.
const router = createDashboardRouter();
const services = { collector: defaultSystemCollector() };

void startBackgroundServices();

export function attachDevDashboardMiddleware(middlewares: Connect.Server): void {
    middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://dev-dashboard.local");

        if (!(await requireDashboardAuth(req, res, url))) {
            return;
        }

        const handled = await handleWithRouter(router, req, res, { services });

        if (!handled) {
            next();
        }
    });
}
