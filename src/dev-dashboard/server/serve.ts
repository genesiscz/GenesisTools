import { hostname } from "node:os";
import { getDashboardAuthCached } from "@app/dev-dashboard/config";
import { LOCAL_ORIGIN_HEADER } from "@app/dev-dashboard/lib/auth";
import type { KeyPair } from "@app/dev-dashboard/lib/e2e/box";
import { fromBase64, loadOrCreateAgentKeys, naclBoxCipher } from "@app/dev-dashboard/lib/e2e/box";
import { isLoopbackOnlyOrigin } from "@app/dev-dashboard/lib/front-proxy";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import type { AuthResult } from "@app/dev-dashboard/server/auth-guard";
import { decideApiAuth } from "@app/dev-dashboard/server/auth-guard";
import { defaultSystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { createDashboardRouter, startBackgroundServices } from "@app/dev-dashboard/server/registry";
import type { Router } from "@app/dev-dashboard/server/router";
import { loadPeers } from "@app/dev-dashboard/server/routes/e2e";
import { setDashboardBoundHost, setDashboardBoundPort } from "@app/dev-dashboard/server/routes/net";
import { handleE2eRpc } from "@app/dev-dashboard/server/transport/e2e-rpc";
import { startMdnsAdvertiser } from "@app/dev-dashboard/server/transport/mdns-advertiser";
import type { RouteServices } from "@app/dev-dashboard/server/types";
import { logger, out } from "@app/logger";

export interface ServeAgentOptions {
    port: number;
    host?: string;
    /** Advertise `_devdashboard._tcp` over Bonjour for the mobile LAN tier. Default: true. */
    advertiseMdns?: boolean;
    /**
     * Accept end-to-end-encrypted requests on `POST /api/e2e/rpc` (managed tier). Default: off.
     * When on, `/api/e2e/rpc` and `/api/e2e/pair` BYPASS Basic auth — the paired-key allowlist +
     * box MAC IS the auth for rpc, and pairing is TOFU-public (it carries only public keys).
     */
    e2e?: boolean;
}

const E2E_RPC_PATH = "/api/e2e/rpc";
const E2E_PAIR_PATH = "/api/e2e/pair";

/** Map an auth decision to a deny/unconfigured Response, or null when the request is allowed. */
function denyResponse(auth: AuthResult): Response | null {
    if (auth.decision === "deny") {
        return new Response("Authentication required.", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="DevDashboard Agent", charset="UTF-8"' },
        });
    }

    if (auth.decision === "unconfigured") {
        return new Response("Dashboard auth is enabled but no password hash is configured.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
    }

    return null;
}

/**
 * Handle a managed-tier `POST /api/e2e/rpc`: read the envelope, snapshot the paired-key
 * allowlist for this request, and run the rpc handler. ANY failure (bad envelope, unpaired
 * epk, MAC fail) returns a GENERIC 403 with no detail — never reveal which check failed, or
 * the endpoint becomes a decryption oracle. The real reason is logged via `logger.warn`.
 */
async function serveE2eRpc(
    req: Request,
    agentKeys: KeyPair,
    router: Router,
    services: RouteServices
): Promise<Response> {
    try {
        const rawEnvelope = await req.text();
        const peers = await loadPeers();
        const resolvePeerKey = (epkB64: string): Uint8Array | null => {
            const record = peers[epkB64];
            return record ? fromBase64(record.publicKey) : null;
        };

        const responseEnvelope = await handleE2eRpc(rawEnvelope, {
            cipher: naclBoxCipher,
            agentKeys,
            resolvePeerKey,
            router,
            services,
        });

        return new Response(responseEnvelope, {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: e2e rpc rejected");
        return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
}

/**
 * The standalone DevDashboard Agent: serves the `/api/*` contract over `Bun.serve`
 * with NO Vite dependency — the same registry the web middleware delegates to. Auth
 * mirrors the web path (`decideApiAuth`, which reuses `lib/auth.ts`): loopback / Basic
 * (mints the `dd_session` cookie) / cookie. ttyd terminals still ride the front-proxy;
 * this serves the JSON + SSE + binary surface.
 */
export async function serveAgent(opts: ServeAgentOptions): Promise<void> {
    const router = createDashboardRouter();
    const services = { collector: defaultSystemCollector() };
    await startBackgroundServices();

    // Build the Agent's long-term keypair ONCE at startup (per-request keygen/disk I/O would
    // be both slow and wrong). Only when E2E is enabled.
    const agentKeys = opts.e2e ? await loadOrCreateAgentKeys() : null;

    if (agentKeys) {
        logger.info("dev-dashboard: E2E rpc enabled (POST /api/e2e/rpc bypasses Basic auth)");
    }

    const host = opts.host ?? "0.0.0.0";
    const server = Bun.serve({
        port: opts.port,
        hostname: host,
        idleTimeout: 0,
        async fetch(req, srv) {
            const url = new URL(req.url);
            const headers: Record<string, string> = {};
            req.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value;
            });

            // Mirror the web/front-proxy loopback grant: a GENUINE loopback hit (real 127.0.0.1
            // socket + localhost Host + no cf/forwarded edge headers) is trusted, exactly as the
            // browser path is. Locality is derived from the socket — never from the inbound header,
            // which is stripped here first so a remote client can't spoof it. `decideApiAuth`
            // already honors LOCAL_ORIGIN_HEADER; this is the missing socket→header bridge the
            // docstring promised. ttyd/WS still ride the front-proxy.
            delete headers[LOCAL_ORIGIN_HEADER];
            if (isLoopbackOnlyOrigin(req, srv.requestIP(req)?.address)) {
                headers[LOCAL_ORIGIN_HEADER] = "1";
            }

            // E2E pairing + rpc BYPASS Basic auth: pairing is TOFU-public (public keys only),
            // and the rpc allowlist+box MAC is itself the auth. Gate the rpc handler on `e2e`.
            const isE2eBypass = url.pathname === E2E_RPC_PATH || url.pathname === E2E_PAIR_PATH;

            if (agentKeys && req.method === "POST" && url.pathname === E2E_RPC_PATH) {
                return serveE2eRpc(req, agentKeys, router, services);
            }

            if (!isE2eBypass) {
                const auth = decideApiAuth({
                    method: req.method,
                    pathname: url.pathname,
                    headers,
                    provision: await getDashboardAuthCached(),
                    secure: headers["x-forwarded-proto"] === "https",
                });

                const denied = denyResponse(auth);

                if (denied) {
                    return denied;
                }

                const res = await routerToResponse(router, req, { services });

                if (!res) {
                    return new Response("Not found", { status: 404 });
                }

                if (auth.setCookie) {
                    res.headers.append("Set-Cookie", auth.setCookie);
                }

                return res;
            }

            // `/api/e2e/pair` (and `/api/e2e/rpc` when e2e is off): no auth, straight to the router.
            const res = await routerToResponse(router, req, { services });

            return res ?? new Response("Not found", { status: 404 });
        },
    });

    setDashboardBoundPort(server.port ?? opts.port);
    setDashboardBoundHost(host);

    logger.info({ port: server.port, host }, "DevDashboard Agent listening");
    out.println(`DevDashboard Agent on http://${host}:${server.port} (API only, no Vite)`);

    if (opts.advertiseMdns !== false) {
        const advertiser = startMdnsAdvertiser({
            instanceName: hostname(),
            port: server.port ?? opts.port,
            txt: { v: "1" },
        });
        const stop = () => advertiser.stop();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    }
}
