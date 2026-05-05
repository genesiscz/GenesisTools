import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionFilePath } from "@app/debugging-master/core/paths";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import { sseBroadcaster } from "@app/debugging-master/core/sse-broadcaster";
import type { IndexedLogEntry, LogEntry, SessionMeta } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";

const sessionManager = new SessionManager();

const SESSION_NAME = /^[a-zA-Z0-9_-]+$/;
const REF_ID = /^([a-z])(\d+)$/;

const DASHBOARD_DIST = resolve(import.meta.dir, "..", "dashboard", "dist");

interface JsonInit {
    status?: number;
    headers?: Record<string, string>;
}

function jsonResponse(body: unknown, cors: Record<string, string>, init: JsonInit = {}): Response {
    return new Response(SafeJSON.stringify(body), {
        status: init.status ?? 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...cors,
            ...(init.headers ?? {}),
        },
    });
}

/**
 * Handle dashboard routes (HTML shell + /api/*). Returns null if the path
 * is not a dashboard route so the caller can fall through to its 404.
 */
export async function handleDashboardRequest(
    req: Request,
    url: URL,
    cors: Record<string, string>
): Promise<Response | null> {
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
        return handleApiRequest(req, url, cors);
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return serveStatic(join(DASHBOARD_DIST, "index.html"), cors, { fallback: notBuiltHtml() });
    }

    if (req.method === "GET" && pathname.startsWith("/assets/")) {
        const safe = sanitizeAssetPath(pathname);
        if (!safe) {
            return new Response("forbidden", { status: 403, headers: cors });
        }
        return serveStatic(join(DASHBOARD_DIST, safe), cors);
    }

    if (req.method === "GET" && pathname === "/favicon.ico") {
        const file = join(DASHBOARD_DIST, "favicon.ico");
        if (existsSync(file)) {
            return serveStatic(file, cors);
        }
        return new Response(null, { status: 204, headers: cors });
    }

    return null;
}

async function handleApiRequest(req: Request, url: URL, cors: Record<string, string>): Promise<Response> {
    const { pathname } = url;
    const method = req.method;

    if (method === "GET" && pathname === "/api/sessions") {
        const sessions = await listSessions();
        return jsonResponse({ sessions }, cors);
    }

    const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (!match) {
        return jsonResponse({ error: "not found" }, cors, { status: 404 });
    }

    const sessionName = match[1];
    const sub = match[2] ?? "";

    if (!SESSION_NAME.test(sessionName)) {
        return jsonResponse({ error: "invalid session name" }, cors, { status: 400 });
    }

    if (method === "GET" && sub === "") {
        const meta = await readSessionMeta(sessionName);
        if (!meta) {
            return jsonResponse({ error: "session not found" }, cors, { status: 404 });
        }
        const entries = await readEntries(sessionName);
        return jsonResponse({ meta, entryCount: entries.length }, cors);
    }

    if (method === "GET" && sub === "entries") {
        // Validate + clamp: NaN/negative inputs collapse to safe defaults,
        // and `limit` is hard-capped at 5000 so a malicious or careless query
        // can't force the server to slice and serialize a huge array.
        const rawSince = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
        const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "5000", 10);
        const since = Number.isFinite(rawSince) ? Math.max(0, rawSince) : 0;
        const limit = Number.isFinite(rawLimit) ? Math.min(5000, Math.max(1, rawLimit)) : 5000;
        const all = await readEntries(sessionName);
        const indexed: IndexedLogEntry[] = all.map((e, i) => ({ ...e, index: i + 1 }));
        const sliced = indexed.slice(since, since + limit);
        return jsonResponse({ entries: sliced, total: indexed.length }, cors);
    }

    if (method === "GET" && sub === "stream") {
        const { stream, unsubscribe } = sseBroadcaster.subscribe(sessionName);
        req.signal?.addEventListener("abort", unsubscribe, { once: true });
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
                ...cors,
            },
        });
    }

    const expandMatch = sub.match(/^expand\/(.+)$/);
    if (method === "GET" && expandMatch) {
        const refId = expandMatch[1];
        const refMatch = refId.match(REF_ID);
        if (!refMatch) {
            return jsonResponse({ error: "invalid ref id" }, cors, { status: 400 });
        }
        const prefix = refMatch[1];
        const entryIndex = Number.parseInt(refMatch[2], 10);
        const entries = await readEntries(sessionName);
        const entry = entries[entryIndex - 1];
        if (!entry) {
            return jsonResponse({ error: "entry not found" }, cors, { status: 404 });
        }
        const data = resolveRefData(entry, prefix);
        return jsonResponse({ refId, index: entryIndex, level: entry.level, data }, cors);
    }

    if (method === "DELETE" && sub === "") {
        const path = await sessionJsonlPath(sessionName);
        if (!path) {
            return jsonResponse({ error: "session not found" }, cors, { status: 404 });
        }
        await Bun.write(path, "");
        sseBroadcaster.publishCleared(sessionName);
        return jsonResponse({ cleared: true }, cors);
    }

    return jsonResponse({ error: "method not allowed" }, cors, { status: 405 });
}

function resolveRefData(entry: LogEntry, prefix: string): unknown {
    if (prefix === "s") {
        return entry.vars ?? null;
    }

    if (prefix === "e" && entry.data && entry.stack) {
        if (typeof entry.data === "object" && !Array.isArray(entry.data)) {
            return { ...(entry.data as Record<string, unknown>), _stack: entry.stack };
        }

        return { data: entry.data, _stack: entry.stack };
    }

    return entry.data ?? entry.stack ?? null;
}

async function listSessions(): Promise<SessionMeta[]> {
    const names = await sessionManager.listSessionNames();
    const out: SessionMeta[] = [];
    for (const name of names) {
        const meta = await sessionManager.getSessionMeta(name);
        if (meta) {
            const enriched = meta.lastActivityAt > 0 ? meta : enrichWithFileStat(meta, name);
            out.push(enriched);
            continue;
        }
        // Sessions written via the dbg snippet (no `start` command run) have no
        // meta.json — fall back to the JSONL file's mtime/birthtime so they
        // still sort and display sensibly.
        out.push(enrichWithFileStat({ name, projectPath: "", createdAt: 0, lastActivityAt: 0 }, name));
    }
    return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function enrichWithFileStat(meta: SessionMeta, name: string): SessionMeta {
    try {
        const st = statSync(sessionFilePath(name));
        return {
            ...meta,
            createdAt: meta.createdAt > 0 ? meta.createdAt : st.birthtimeMs,
            lastActivityAt: meta.lastActivityAt > 0 ? meta.lastActivityAt : st.mtimeMs,
        };
    } catch {
        return meta;
    }
}

async function readEntries(sessionName: string): Promise<LogEntry[]> {
    return sessionManager.readEntries(sessionName);
}

async function readSessionMeta(sessionName: string): Promise<SessionMeta | null> {
    return sessionManager.getSessionMeta(sessionName);
}

async function sessionJsonlPath(sessionName: string): Promise<string | null> {
    const path = await sessionManager.getSessionPath(sessionName);
    return existsSync(path) ? path : null;
}

function sanitizeAssetPath(pathname: string): string | null {
    const stripped = pathname.replace(/^\/+/, "");
    if (stripped.includes("..") || stripped.includes("\0")) {
        return null;
    }
    return stripped;
}

async function serveStatic(
    filePath: string,
    cors: Record<string, string>,
    opts: { fallback?: { status: number; body: string; contentType: string } } = {}
): Promise<Response> {
    if (!existsSync(filePath)) {
        if (opts.fallback) {
            return new Response(opts.fallback.body, {
                status: opts.fallback.status,
                headers: { "Content-Type": opts.fallback.contentType, ...cors },
            });
        }
        return new Response("not found", { status: 404, headers: cors });
    }

    const file = Bun.file(filePath);
    return new Response(file, {
        headers: {
            "Cache-Control": filePath.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
            ...cors,
        },
    });
}

function notBuiltHtml(): { status: number; body: string; contentType: string } {
    return {
        status: 503,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>debugging-master — dashboard not built</title>
<style>
  body { background:#0a0a0a; color:#ffb84d; font:14px/1.5 ui-monospace,Menlo,monospace; padding:32px; }
  h1 { color:#ff6b35; text-shadow:0 0 8px rgba(255,107,53,.6); margin:0 0 16px; }
  code { background:#1a1a1a; padding:2px 6px; border:1px solid #333; border-radius:4px; }
  .pulse { display:inline-block; width:8px; height:8px; background:#ff6b35; border-radius:50%; margin-right:8px;
    box-shadow:0 0 8px #ff6b35; animation:pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
</style></head>
<body>
  <h1><span class="pulse"></span>DASHBOARD NOT BUILT</h1>
  <p>The dashboard frontend hasn't been built yet. Run:</p>
  <p><code>tools debugging-master dashboard build</code></p>
  <p>then refresh this page.</p>
  <p style="opacity:.6;margin-top:32px">ingest server is up — <code>POST /log/&lt;session&gt;</code> still works.</p>
</body></html>`,
    };
}
