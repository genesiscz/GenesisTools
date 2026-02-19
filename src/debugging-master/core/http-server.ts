import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LogEntry } from "@app/debugging-master/types";

const SESSIONS_DIR = join(homedir(), ".genesis-tools", "debugging-master", "sessions");

function ensureDir(): void {
	if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Parse and normalize an incoming log entry. Never throws.
 */
function normalizeEntry(body: string): LogEntry {
	try {
		const parsed = JSON.parse(body);
		return {
			level: parsed.level ?? "info",
			ts: parsed.ts ?? Date.now(),
			...parsed,
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

	const server = Bun.serve({
		port,
		fetch(req) {
			const url = new URL(req.url);

			// Health check
			if (req.method === "GET" && url.pathname === "/health") {
				return new Response(JSON.stringify({ status: "ok", uptime: process.uptime() }), {
					headers: { "Content-Type": "application/json" },
				});
			}

			// Log ingestion: POST /log/<session-name>
			if (req.method === "POST" && url.pathname.startsWith("/log/")) {
				const sessionName = url.pathname.slice(5);
				if (!sessionName) {
					return new Response("Missing session name", { status: 400 });
				}

				return req.text().then((body) => {
					const entry = normalizeEntry(body);
					const path = join(SESSIONS_DIR, `${sessionName}.jsonl`);
					appendFileSync(path, JSON.stringify(entry) + "\n");
					return new Response("ok", { status: 200 });
				});
			}

			// Clear session: DELETE /log/<session-name>
			if (req.method === "DELETE" && url.pathname.startsWith("/log/")) {
				const sessionName = url.pathname.slice(5);
				const path = join(SESSIONS_DIR, `${sessionName}.jsonl`);
				try {
					Bun.write(path, "");
					return new Response("cleared", { status: 200 });
				} catch {
					return new Response("session not found", { status: 404 });
				}
			}

			return new Response("not found", { status: 404 });
		},
	});

	return { server, port: server.port ?? port };
}
