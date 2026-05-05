import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { handleDashboardRequest } from "@app/debugging-master/core/dashboard-server";
import { SESSIONS_DIR, sessionFilePath } from "@app/debugging-master/core/paths";
import { sseBroadcaster } from "@app/debugging-master/core/sse-broadcaster";
import type { LogEntry } from "@app/debugging-master/types";

import { SafeJSON } from "@app/utils/json";

function ensureDir(): void {
    if (!existsSync(SESSIONS_DIR)) {
        mkdirSync(SESSIONS_DIR, { recursive: true });
    }
}

/**
 * Parse and normalize an incoming log entry. Never throws.
 */
const VALID_LEVELS = new Set([
    "dump",
    "info",
    "warn",
    "error",
    "timer-start",
    "timer-end",
    "checkpoint",
    "assert",
    "snapshot",
    "trace",
]);

function normalizeEntry(body: string): LogEntry {
    try {
        const parsed = SafeJSON.parse(body, { strict: true });
        const level = VALID_LEVELS.has(parsed.level) ? parsed.level : "raw";
        return {
            ...parsed,
            level,
            ts: parsed.ts ?? Date.now(),
        } as LogEntry;
    } catch {
        return {
            level: "raw",
            data: body,
            ts: Date.now(),
        };
    }
}

/**
 * Start the HTTP ingest server. Live SSE fan-out is driven by the
 * `FileTailer` inside `SSEBroadcaster` (watches the JSONL on disk), so the
 * ingest path doesn't need to broadcast — works whether writes come from
 * this process or another.
 */
export function startServer(port: number = 7243): { server: ReturnType<typeof Bun.serve>; port: number } {
    ensureDir();

    const SAFE_SESSION_NAME = /^[a-zA-Z0-9_-]+$/;

    const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    const server = Bun.serve({
        port,
        hostname: "0.0.0.0",
        // Idle timeout 2 minutes. SSE heartbeats fire every 15s (well within
        // this window) so streams stay open. The non-zero timeout is a safety
        // net: if a connection genuinely goes silent (network glitch, sleeping
        // laptop), the server reaps it instead of leaking forever. Bun's
        // default 10s would kill SSE between heartbeats and trigger a
        // reconnect storm.
        idleTimeout: 120,
        async fetch(req) {
            const url = new URL(req.url);

            // CORS preflight
            if (req.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: corsHeaders });
            }

            // Health check
            if (req.method === "GET" && url.pathname === "/health") {
                return new Response(SafeJSON.stringify({ status: "ok", uptime: process.uptime() }), {
                    headers: { "Content-Type": "application/json", ...corsHeaders },
                });
            }

            // Log ingestion: POST /log/<session-name>
            if (req.method === "POST" && url.pathname.startsWith("/log/")) {
                const sessionName = url.pathname.slice(5);
                if (!sessionName || !SAFE_SESSION_NAME.test(sessionName)) {
                    return new Response("Invalid session name", { status: 400, headers: corsHeaders });
                }

                return req.text().then((body) => {
                    const entry = normalizeEntry(body);
                    const path = sessionFilePath(sessionName);
                    appendFileSync(path, `${SafeJSON.stringify(entry)}\n`);
                    return new Response("ok", { status: 200, headers: corsHeaders });
                });
            }

            // Clear session: DELETE /log/<session-name>
            if (req.method === "DELETE" && url.pathname.startsWith("/log/")) {
                const sessionName = url.pathname.slice(5);
                if (!sessionName || !SAFE_SESSION_NAME.test(sessionName)) {
                    return new Response("Invalid session name", { status: 400, headers: corsHeaders });
                }
                const path = sessionFilePath(sessionName);
                try {
                    await Bun.write(path, "");
                    sseBroadcaster.publishCleared(sessionName);
                    return new Response("cleared", { status: 200, headers: corsHeaders });
                } catch {
                    return new Response("session not found", { status: 404, headers: corsHeaders });
                }
            }

            // Dashboard routes (HTML + /api/*)
            const dashboardResponse = await handleDashboardRequest(req, url, corsHeaders);
            if (dashboardResponse) {
                return dashboardResponse;
            }

            return new Response("not found", { status: 404, headers: corsHeaders });
        },
    });

    return { server, port: server.port ?? port };
}
