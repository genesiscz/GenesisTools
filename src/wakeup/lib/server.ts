import { SafeJSON } from "@app/utils/json";
import type { Storage } from "@app/utils/storage";
import {
    DEFAULT_HTTP_PORT,
    DEFAULT_WOL_PORT,
    type RegisteredClient,
    readWakeupConfig,
    updateWakeupConfig,
} from "../config";
import { sendWakePacket } from "./wol";

export interface WakeServerOptions {
    port: number;
    hostname?: string;
    token?: string;
    defaultMac?: string;
    broadcast?: string;
    wolPort?: number;
    logRequests?: boolean;
    storage?: Storage;
}

interface WakeRequestBody {
    name?: string;
    password?: string;
    mac?: string;
    broadcast?: string;
    port?: number;
    token?: string;
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

    if (auth?.toLowerCase().startsWith("bearer ")) {
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

        return SafeJSON.parse(text) as WakeRequestBody;
    } catch {
        return null;
    }
}

function json(data: unknown, status = 200): Response {
    return new Response(SafeJSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function logRequest(message: string, opts: WakeServerOptions, extra?: Record<string, unknown>): void {
    if (!opts.logRequests) {
        return;
    }

    const payload = extra ? ` ${SafeJSON.stringify(extra)}` : "";
    console.log(`[wakeup] ${message}${payload}`);
}

async function loadClients(storage: Storage | undefined): Promise<Map<string, RegisteredClient>> {
    if (!storage) {
        return new Map();
    }

    const config = await readWakeupConfig(storage);
    const clients = config.server?.clients ?? [];
    const map = new Map<string, RegisteredClient>();

    for (const client of clients) {
        map.set(client.name, client);
    }

    return map;
}

async function persistClients(
    storage: Storage | undefined,
    clients: Map<string, RegisteredClient>,
    opts: WakeServerOptions
): Promise<void> {
    if (!storage) {
        return;
    }

    await updateWakeupConfig(storage, (current) => {
        const next = { ...current };
        const existingServer = next.server ?? {};

        next.server = {
            ...existingServer,
            host: opts.hostname ?? existingServer.host,
            port: opts.port ?? existingServer.port ?? DEFAULT_HTTP_PORT,
            token: opts.token ?? existingServer.token,
            broadcast: opts.broadcast ?? existingServer.broadcast ?? "255.255.255.255",
            wolPort: opts.wolPort ?? existingServer.wolPort ?? DEFAULT_WOL_PORT,
            defaultMac: opts.defaultMac ?? existingServer.defaultMac,
            logRequests: opts.logRequests ?? existingServer.logRequests,
            clients: Array.from(clients.values()),
        };

        return next;
    });
}

function readNameAndPassword(
    body: WakeRequestBody | null,
    url: URL
): { name: string | undefined; password: string | undefined } {
    const name = body?.name ?? url.searchParams.get("name") ?? undefined;
    const password = body?.password ?? url.searchParams.get("password") ?? undefined;
    return { name, password };
}

export async function runWakeServer(opts: WakeServerOptions): Promise<void> {
    const hostname = opts.hostname ?? "0.0.0.0";
    const broadcast = opts.broadcast ?? "255.255.255.255";
    const wolPort = opts.wolPort ?? DEFAULT_WOL_PORT;
    const token = opts.token;
    const defaultMac = opts.defaultMac;
    const clients = await loadClients(opts.storage);

    const server = Bun.serve({
        hostname,
        port: opts.port,
        async fetch(req) {
            const url = new URL(req.url);

            if (url.pathname === "/health") {
                return json({ status: "ok" });
            }

            if (!authorize(req, token)) {
                logRequest("unauthorized request", opts);
                return json({ error: "unauthorized" }, 401);
            }

            let body: WakeRequestBody | null = null;

            if (req.method === "POST") {
                body = await readBody(req);
            }

            if (url.pathname === "/register") {
                if (!body) {
                    return json({ error: "request body required" }, 400);
                }

                const { name, password } = readNameAndPassword(body, url);

                if (!name || !password) {
                    return json({ error: "name and password are required" }, 400);
                }

                const clientMac = body.mac ?? defaultMac;

                if (!clientMac) {
                    return json({ error: "mac is required" }, 400);
                }

                const clientBroadcast = body.broadcast ?? broadcast;
                const clientPort = body.port ?? wolPort;

                const record: RegisteredClient = {
                    name,
                    password,
                    mac: clientMac,
                    broadcast: clientBroadcast,
                    wolPort: clientPort,
                };

                clients.set(name, record);
                await persistClients(opts.storage, clients, opts);
                logRequest("registered client", opts, { name, mac: record.mac, broadcast: record.broadcast });

                return json({ ok: true, client: record });
            }

            if (url.pathname === "/login") {
                const { name, password } = readNameAndPassword(body, url);

                if (!name || !password) {
                    return json({ error: "name and password are required" }, 400);
                }

                const client = clients.get(name);

                if (!client) {
                    return json({ error: "client not found" }, 404);
                }

                if (client.password !== password) {
                    return json({ error: "invalid password" }, 401);
                }

                logRequest("client login", opts, { name });
                return json({ ok: true, client: { ...client, password: undefined } });
            }

            if (url.pathname === "/wake") {
                const { name, password } = readNameAndPassword(body, url);

                let packetMac = body?.mac ?? url.searchParams.get("mac") ?? defaultMac;
                let packetBroadcast = body?.broadcast ?? url.searchParams.get("broadcast") ?? broadcast;
                let packetPort =
                    body?.port ??
                    (url.searchParams.get("port") ? Number(url.searchParams.get("port")) : undefined) ??
                    wolPort;

                if (name) {
                    const client = clients.get(name);

                    if (!client) {
                        return json({ error: "client not found" }, 404);
                    }

                    if (client.password !== password) {
                        return json({ error: "invalid password" }, 401);
                    }

                    packetMac = client.mac;
                    packetBroadcast = client.broadcast ?? packetBroadcast;
                    packetPort = client.wolPort ?? packetPort;
                }

                if (!packetMac) {
                    return json({ error: "mac is required" }, 400);
                }

                try {
                    const result = await sendWakePacket({
                        mac: packetMac,
                        broadcast: packetBroadcast,
                        port: packetPort,
                        password,
                    });
                    logRequest("sent magic packet", opts, { ...result });
                    return json({ ok: true, ...result });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logRequest("wake failed", opts, { mac: packetMac, error: message });
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
