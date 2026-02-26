import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LogEntry } from "@app/debugging-master/types";

const SESSIONS_DIR = join(homedir(), ".genesis-tools", "debugging-master", "sessions");

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
        const parsed = JSON.parse(body);
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
 * Start the HTTP ingest server.
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
        hostname: "127.0.0.1",
        async fetch(req) {
            const url = new URL(req.url);

            // CORS preflight
            if (req.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: corsHeaders });
            }

            // Health check
            if (req.method === "GET" && url.pathname === "/health") {
                return new Response(JSON.stringify({ status: "ok", uptime: process.uptime() }), {
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
                    const path = join(SESSIONS_DIR, `${sessionName}.jsonl`);
                    appendFileSync(path, `${JSON.stringify(entry)}\n`);
                    return new Response("ok", { status: 200, headers: corsHeaders });
                });
            }

            // Clear session: DELETE /log/<session-name>
            if (req.method === "DELETE" && url.pathname.startsWith("/log/")) {
                const sessionName = url.pathname.slice(5);
                if (!sessionName || !SAFE_SESSION_NAME.test(sessionName)) {
                    return new Response("Invalid session name", { status: 400, headers: corsHeaders });
                }
                const path = join(SESSIONS_DIR, `${sessionName}.jsonl`);
                try {
                    await Bun.write(path, "");
                    return new Response("cleared", { status: 200, headers: corsHeaders });
                } catch {
                    return new Response("session not found", { status: 404, headers: corsHeaders });
                }
            }

            return new Response("not found", { status: 404, headers: corsHeaders });
        },
    });

    return { server, port: server.port ?? port };
}
