import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { sseBroadcaster } from "@app/debugging-master/core/sse-broadcaster";
import type { IndexedLogEntry, LogEntry } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";
import type { DashboardSession, LogSourceId } from "@app/utils/log-viewer/log-source";
import { getAllLogSources, getLogSource } from "@app/utils/log-viewer/resolve-log-source";
import { isLogSourceId } from "@app/utils/log-viewer/session-key";
import { enrichDashboardTimestamps } from "@app/utils/log-viewer/tail-bridge";
import { decodeSessionPathSegment, isSafeLogSessionName } from "@app/utils/log-viewer/session-name";

const REF_ID = /^([se])([1-9]\d*)$/;

const DASHBOARD_DIST = resolve(import.meta.dir, "..", "dashboard", "dist");

interface JsonInit {
    status?: number;
    headers?: Record<string, string>;
}

interface ResolvedRoute {
    source: LogSourceId;
    sessionName: string;
    sub: string;
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

function resolveRoute(pathname: string): ResolvedRoute | null {
    const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?(?:\/(.*))?$/);
    if (!match) {
        return null;
    }

    const first = match[1];
    const second = match[2];
    const rest = match[3] ?? "";

    if (isLogSourceId(first) && second) {
        return { source: first, sessionName: decodeSessionPathSegment(second), sub: rest };
    }

    return {
        source: "debugging-master",
        sessionName: decodeSessionPathSegment(first),
        sub: second ? (rest ? `${second}/${rest}` : second) : "",
    };
}

async function handleApiRequest(req: Request, url: URL, cors: Record<string, string>): Promise<Response> {
    const { pathname } = url;
    const method = req.method;

    if (method === "GET" && pathname === "/api/sessions") {
        const sessions = await listSessions();
        return jsonResponse({ sessions }, cors);
    }

    const route = resolveRoute(pathname);
    if (!route) {
        return jsonResponse({ error: "not found" }, cors, { status: 404 });
    }

    const { source, sessionName, sub } = route;

    if (!isSafeLogSessionName(sessionName)) {
        return jsonResponse({ error: "invalid session name" }, cors, { status: 400 });
    }

    const logSource = getLogSource(source);

    if (method === "GET" && sub === "") {
        const session = await findDashboardSession(source, sessionName);
        if (!session) {
            return jsonResponse({ error: "session not found" }, cors, { status: 404 });
        }
        const entries = await logSource.readEntries(sessionName);
        return jsonResponse({ meta: session, entryCount: entries.length }, cors);
    }

    if (method === "GET" && sub === "entries") {
        const rawSince = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
        const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "5000", 10);
        const since = Number.isFinite(rawSince) ? Math.max(0, rawSince) : 0;
        const limit = Number.isFinite(rawLimit) ? Math.min(5000, Math.max(1, rawLimit)) : 5000;
        const all = await logSource.readEntries(sessionName);
        const indexed: IndexedLogEntry[] = all.map((e, i) => ({ ...e, index: i + 1 }));
        const sliced = indexed.slice(since, since + limit);
        return jsonResponse({ entries: sliced, total: indexed.length, source }, cors);
    }

    if (method === "GET" && sub === "stream") {
        const { stream, unsubscribe } = sseBroadcaster.subscribe(source, sessionName);
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
        const entries = await logSource.readEntries(sessionName);
        const entry = entries[entryIndex - 1];
        if (!entry) {
            return jsonResponse({ error: "entry not found" }, cors, { status: 404 });
        }
        const data = resolveRefData(entry, prefix);
        return jsonResponse({ refId, index: entryIndex, level: entry.level, data }, cors);
    }

    if (method === "DELETE" && sub === "") {
        const path = logSource.getJsonlPath(sessionName);
        if (!existsSync(path)) {
            return jsonResponse({ error: "session not found" }, cors, { status: 404 });
        }
        await Bun.write(path, "");
        sseBroadcaster.publishCleared(source, sessionName);
        return jsonResponse({ cleared: true, source }, cors);
    }

    return jsonResponse({ error: "not found" }, cors, { status: 404 });
}

function resolveRefData(entry: LogEntry, prefix: string): unknown {
    if (prefix === "s") {
        return entry.vars ?? null;
    }

    if (prefix === "e" && entry.data != null && entry.stack) {
        if (typeof entry.data === "object" && !Array.isArray(entry.data)) {
            return { ...(entry.data as Record<string, unknown>), _stack: entry.stack };
        }

        return { data: entry.data, _stack: entry.stack };
    }

    return entry.data ?? entry.stack ?? null;
}

async function listSessions(): Promise<DashboardSession[]> {
    const all: DashboardSession[] = [];

    for (const source of getAllLogSources()) {
        const listed = await source.listSessions();
        for (const session of listed) {
            const times = enrichDashboardTimestamps(session, session.jsonlPath);
            all.push({
                source: session.source,
                name: session.name,
                badge: session.badge,
                projectPath: session.projectPath ?? session.command ?? "",
                command: session.command,
                createdAt: times.createdAt,
                lastActivityAt: times.lastActivityAt,
                entryCount: session.entryCount,
            });
        }
    }

    return all.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

async function findDashboardSession(source: LogSourceId, name: string): Promise<DashboardSession | null> {
    const sessions = await listSessions();
    return sessions.find((s) => s.source === source && s.name === name) ?? null;
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
  <p style="opacity:.6;margin-top:32px">ingest server is up — unified dbg + task sessions.</p>
</body></html>`,
    };
}
