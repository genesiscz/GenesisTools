import { sendWakePacket } from "./wol";

export interface WakeServerOptions {
    port: number;
    hostname?: string;
    token?: string;
    defaultMac?: string;
    broadcast?: string;
    wolPort?: number;
    logRequests?: boolean;
}

interface WakeRequestBody {
    mac?: string;
    broadcast?: string;
    port?: number;
    token?: string;
    password?: string;
}

function authorize(req: Request, expectedToken: string | undefined): boolean {
    if (!expectedToken) {
        return true;
    }

    const url = new URL(req.url);

    if (url.searchParams.get("token") === expectedToken) {
        return true;
    }

    const auth = req.headers.get("authorization");

    if (auth && auth.toLowerCase().startsWith("bearer ")) {
        const token = auth.slice(7).trim();
        return token === expectedToken;
    }

    return false;
}

async function readBody(req: Request): Promise<WakeRequestBody | null> {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
        try {
            return (await req.json()) as WakeRequestBody;
        } catch {
            return null;
        }
    }

    if (contentType.includes("application/x-www-form-urlencoded")) {
        const text = await req.text();
        const params = new URLSearchParams(text);
        return {
            mac: params.get("mac") ?? undefined,
            broadcast: params.get("broadcast") ?? undefined,
            port: params.get("port") ? Number(params.get("port")) : undefined,
            token: params.get("token") ?? undefined,
            password: params.get("password") ?? undefined,
        };
    }

    try {
        const text = await req.text();

        if (!text) {
            return null;
        }

        return JSON.parse(text) as WakeRequestBody;
    } catch {
        return null;
    }
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function logRequest(message: string, opts: WakeServerOptions, extra?: Record<string, unknown>): void {
    if (!opts.logRequests) {
        return;
    }

    const payload = extra ? ` ${JSON.stringify(extra)}` : "";
    console.log(`[wakeup] ${message}${payload}`);
}

export async function runWakeServer(opts: WakeServerOptions): Promise<void> {
    const hostname = opts.hostname ?? "0.0.0.0";
    const broadcast = opts.broadcast ?? "255.255.255.255";
    const wolPort = opts.wolPort ?? 9;
    const token = opts.token;
    const defaultMac = opts.defaultMac;

    const server = Bun.serve({
        hostname,
        port: opts.port,
        async fetch(req) {
            const url = new URL(req.url);

            if (url.pathname === "/health") {
                return json({ status: "ok" });
            }

            if (url.pathname === "/wake") {
                if (!authorize(req, token)) {
                    logRequest("unauthorized request", opts);
                    return json({ error: "unauthorized" }, 401);
                }

                let body: WakeRequestBody | null = null;

                if (req.method === "POST") {
                    body = await readBody(req);
                }

                const mac = body?.mac ?? url.searchParams.get("mac") ?? defaultMac;

                if (!mac) {
                    return json({ error: "mac is required" }, 400);
                }

                const packetBroadcast = body?.broadcast ?? url.searchParams.get("broadcast") ?? broadcast;
                const packetPort =
                    body?.port ??
                    (url.searchParams.get("port") ? Number(url.searchParams.get("port")) : undefined) ??
                    wolPort;
                const password = body?.password ?? url.searchParams.get("password") ?? undefined;

                try {
                    const result = await sendWakePacket({
                        mac,
                        broadcast: packetBroadcast,
                        port: packetPort,
                        password,
                    });
                    logRequest("sent magic packet", opts, result);
                    return json({ ok: true, ...result });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logRequest("wake failed", opts, { mac, error: message });
                    return json({ error: message }, 400);
                }
            }

            return json({ error: "not found" }, 404);
        },
        error(error) {
            console.error("[wakeup] server error", error);
            return json({ error: "server error" }, 500);
        },
    });

    console.log(
        `[wakeup] server listening on http://${hostname}:${opts.port} (default broadcast ${broadcast}:${wolPort})`
    );

    const shutdown = () => {
        try {
            server.stop();
        } catch (err) {
            console.error("[wakeup] stop failed", err);
        }
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    await new Promise<void>(() => {
        /* keep running */
    });
}
