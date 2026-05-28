import type { IncomingMessage, ServerResponse } from "node:http";
import { focusCmuxPane, renameCmuxSurface, renameCmuxWorkspace } from "@app/cmux/lib/controls";
import { getConfig, getDashboardAuthCached } from "@app/dev-dashboard/config";
import {
    buildSessionCookie,
    isCompleteAuthConfig,
    issueSessionToken,
    LOCAL_ORIGIN_HEADER,
    verifyBasicAuthHeader,
    verifySessionToken,
} from "@app/dev-dashboard/lib/auth";
import { getCurrentUsage, getUsageHistory, getUsageHistoryMulti } from "@app/dev-dashboard/lib/claude-usage/aggregator";
import { createDevDashboardTerminal } from "@app/dev-dashboard/lib/cmux/create-terminal";
import { sendTmuxSessionToCmux } from "@app/dev-dashboard/lib/cmux/send-session";
import { fetchCmuxFullLayout } from "@app/utils/cmux/layout";
import type { DashboardSendTarget } from "@app/utils/cmux/types";
import { getCachedSnapshot, startPolling } from "@app/dev-dashboard/lib/cmux/poller";
import { listContainers } from "@app/dev-dashboard/lib/containers/docker";
import {
    getAllRecentRuns,
    getDaemonOverview,
    getRecentRuns,
    getRunLog,
} from "@app/dev-dashboard/lib/daemon-view/aggregator";
import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import {
    findPublishedBySlug,
    listPublished,
    publishNote,
    unpublishNote,
} from "@app/dev-dashboard/lib/obsidian/publish";
import { listVault, readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import { renderSharePage } from "@app/dev-dashboard/lib/obsidian/share-template";
import { enrichQaEntry } from "@app/dev-dashboard/lib/qa-render";
import { createQaStream, todayLogFile } from "@app/dev-dashboard/lib/qa-sse";
import { configureRetention, getCachedPulse, getSeries, startPulsePolling } from "@app/dev-dashboard/lib/system/poller";
import { addTodo, completeTodo, deleteTodo, listTodos } from "@app/dev-dashboard/lib/todos/service";
import { enrichSessionsForHub } from "@app/dev-dashboard/lib/tmux/hub";
import { killTtyd, listTtyd, renameTtyd, spawnTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { fetchWeather } from "@app/dev-dashboard/lib/weather/client";
import { logger } from "@app/logger";
import { defaultDbPath } from "@app/question/commands/log";
import { markEntriesRead, openReadModel, queryEntries } from "@app/question/lib/read-model";
import { getAudioLibrary } from "@app/utils/audio/library";
import { resolveSoundBuffer } from "@app/utils/audio/runner.server";
import { listTmuxSessions } from "@app/utils/tmux/sessions";
import { SafeJSON } from "@app/utils/json";
import type { Connect } from "vite";

let loggedGeneratedPassword = false;

getConfig()
    .then(({ cmuxPollIntervalMs }) => startPolling(cmuxPollIntervalMs))
    .catch((err) => {
        logger.warn({ err }, "dev-dashboard: cmux config load failed, polling with 2000ms default");
        startPolling(2000);
    });

getConfig()
    .then(({ pulse }) => {
        configureRetention(pulse.retentionHours);
        startPulsePolling(pulse.pollIntervalMs);
    })
    .catch((err) => {
        logger.warn({ err }, "dev-dashboard: pulse config load failed, polling with 5000ms default");
        startPulsePolling(5000);
    });

async function readJson<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString("utf8") || "{}";

    return SafeJSON.parse(raw, { strict: true }) as T;
}

function sendJson(res: ServerResponse, status: number, body: object): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(SafeJSON.stringify(body));
}

// Only an exact single-segment /share/<slug> GET bypasses auth. URL already
// normalizes "..", but matching the precise shape (not a startsWith prefix)
// makes the bypass intent explicit and refactor-proof.
const SHARE_BYPASS_RE = /^\/share\/[^/]+$/;

async function requireDashboardAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === "GET" && SHARE_BYPASS_RE.test(url.pathname)) {
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

export function attachDevDashboardMiddleware(middlewares: Connect.Server): void {
    middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://dev-dashboard.local");
        const isAuthorized = await requireDashboardAuth(req, res, url);

        if (!isAuthorized) {
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/tmux/sessions") {
            const sessions = enrichSessionsForHub(listTmuxSessions(), await listTtyd());
            sendJson(res, 200, { sessions });
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/ttyd/list") {
            sendJson(res, 200, { sessions: await listTtyd() });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/ttyd/spawn") {
            try {
                const body = await readJson<{ command?: string; cwd?: string; tmuxSessionName?: string }>(req);
                const session = await spawnTtyd({
                    command: body.command,
                    cwd: body.cwd,
                    attachTmuxSession: body.tmuxSessionName,
                });
                sendJson(res, 200, { session });
            } catch (err) {
                const statusCode = (err as Error & { statusCode?: number }).statusCode;
                sendJson(res, statusCode === 409 ? 409 : 500, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/ttyd/kill") {
            try {
                const body = await readJson<{ id: string; killTmux?: boolean }>(req);
                const ok = await killTtyd(body.id, { killTmux: body.killTmux === true });
                sendJson(res, 200, { ok });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/ttyd/rename") {
            try {
                const body = await readJson<{ id: string; name: string }>(req);
                const ok = await renameTtyd(body.id, body.name);
                sendJson(res, 200, { ok });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/cmux/snapshot") {
            sendJson(res, 200, { snapshot: getCachedSnapshot() });
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/cmux/layout") {
            try {
                const layout = await fetchCmuxFullLayout();
                sendJson(res, 200, { layout });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/cmux/create-terminal") {
            try {
                const body = await readJson<{ cwd?: string }>(req);
                const result = await createDevDashboardTerminal({ cwd: body.cwd });
                sendJson(res, 200, { result });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/cmux/send-session") {
            try {
                const body = await readJson<{ tmuxSessionName: string; target: DashboardSendTarget; cwd?: string }>(req);
                const result = await sendTmuxSessionToCmux(body);
                sendJson(res, 200, { result });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/cmux/attach") {
            try {
                const body = await readJson<{ workspaceId: string; paneId: string }>(req);
                await focusCmuxPane(body);
                sendJson(res, 200, { ok: true });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/cmux/rename") {
            try {
                const body = await readJson<{ workspaceId: string; surfaceId?: string; title: string }>(req);

                if (body.surfaceId) {
                    await renameCmuxSurface({
                        workspaceId: body.workspaceId,
                        surfaceId: body.surfaceId,
                        title: body.title,
                    });
                } else {
                    await renameCmuxWorkspace({ workspaceId: body.workspaceId, title: body.title });
                }

                sendJson(res, 200, { ok: true });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/system/pulse") {
            sendJson(res, 200, getCachedPulse() ?? { capturedAt: null });
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/system/pulse/history") {
            const metric = url.searchParams.get("metric") ?? "cpu";
            const minutes = Number.parseInt(url.searchParams.get("minutes") ?? "30", 10);
            sendJson(res, 200, getSeries(metric, Number.isFinite(minutes) ? minutes : 30));
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/weather") {
            try {
                const { weatherCoords } = await getConfig();
                sendJson(res, 200, await fetchWeather(weatherCoords));
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/claude/usage") {
            try {
                sendJson(res, 200, await getCurrentUsage());
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/claude/usage/history") {
            const account = url.searchParams.get("account") ?? "";
            const bucketsParam = url.searchParams.get("buckets");
            const bucket = url.searchParams.get("bucket") ?? "five_hour";
            const minutes = Number.parseInt(url.searchParams.get("minutes") ?? "1440", 10);
            const safeMinutes = Number.isFinite(minutes) ? minutes : 1440;

            try {
                if (bucketsParam) {
                    const buckets = bucketsParam
                        .split(",")
                        .map((b) => b.trim())
                        .filter(Boolean);
                    sendJson(res, 200, getUsageHistoryMulti({ account, buckets, minutes: safeMinutes }));
                } else {
                    sendJson(res, 200, getUsageHistory({ account, bucket, minutes: safeMinutes }));
                }
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/daemon/status") {
            try {
                sendJson(res, 200, await getDaemonOverview());
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/daemon/runs") {
            const task = url.searchParams.get("task");
            const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
            const safeLimit = Number.isFinite(limit) ? limit : 20;

            try {
                const runs = task ? getRecentRuns({ task, limit: safeLimit }) : getAllRecentRuns(safeLimit);
                sendJson(res, 200, runs);
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/daemon/runs/log") {
            const logFile = url.searchParams.get("logFile");

            if (!logFile) {
                sendJson(res, 400, { error: "missing ?logFile=" });
                return;
            }

            try {
                sendJson(res, 200, getRunLog(logFile));
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/containers") {
            try {
                sendJson(res, 200, await listContainers());
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/qa/log") {
            let db: ReturnType<typeof openReadModel> | undefined;
            try {
                db = openReadModel(defaultDbPath());
                const rows = queryEntries(db, {
                    project: url.searchParams.get("project") ?? undefined,
                    tag: url.searchParams.get("tag") ?? undefined,
                    unread: url.searchParams.get("unread") === "1",
                    limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10),
                });
                sendJson(res, 200, { entries: rows.map((row) => enrichQaEntry(row)) });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            } finally {
                db?.close(); // bun:sqlite has no GC finalizer — close every request or leak an FD (t1)
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/qa/read") {
            let db: ReturnType<typeof openReadModel> | undefined;
            try {
                const body = await readJson<{ ids?: string[] }>(req);
                const ids = body.ids?.filter((id) => typeof id === "string" && id.length > 0) ?? [];
                db = openReadModel(defaultDbPath());
                const updated = markEntriesRead(db, ids);
                sendJson(res, 200, { ok: true, updated });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            } finally {
                db?.close();
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/qa/audio-library") {
            sendJson(res, 200, getAudioLibrary());
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/qa/sound") {
            try {
                const id = url.searchParams.get("id") ?? "";
                const lib = getAudioLibrary();
                const entry = [...lib.bundled, ...lib.synth].find((e) => e.id === id);
                if (!entry) {
                    sendJson(res, 404, { error: `unknown sound id: ${id}` });
                    return;
                }

                const buf = resolveSoundBuffer(entry.choice);
                res.writeHead(200, {
                    "Content-Type": "audio/wav",
                    "Content-Length": String(buf.length),
                    "Cache-Control": "public, max-age=3600",
                });
                res.end(buf);
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/qa/config") {
            try {
                const body = await readJson<{ sound?: string; soundVolume?: number }>(req);
                const args = ["question", "config"];
                if (body.sound) {
                    args.push("--sound", body.sound);
                }

                if (typeof body.soundVolume === "number") {
                    args.push("--sound-volume", String(body.soundVolume));
                }

                const proc = Bun.spawn(["tools", ...args], { stdout: "pipe", stderr: "pipe" });
                const code = await proc.exited;
                sendJson(res, code === 0 ? 200 : 500, {
                    ok: code === 0,
                    output: await new Response(proc.stdout).text(),
                });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/qa/stream") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(": qa stream open\n\n");
            const stream = createQaStream(todayLogFile(), (entry) => {
                res.write(`data: ${SafeJSON.stringify(enrichQaEntry(entry))}\n\n`);
            });
            const keepAlive = setInterval(() => res.write(": ping\n\n"), 12_000);
            const shutdown = (): void => {
                clearInterval(keepAlive);
                stream.close();
            };
            req.on("close", shutdown);
            req.on("aborted", shutdown);
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/todos") {
            const list = url.searchParams.get("list") ?? "GenesisTools";

            try {
                sendJson(res, 200, await listTodos(list));
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const denied = /permission|privacy|reminders|authoriz/i.test(message);
                sendJson(res, denied ? 503 : 500, {
                    error: denied
                        ? "Reminders permission denied. Grant in System Settings → Privacy & Security → Reminders."
                        : message,
                });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/todos") {
            try {
                const body = await readJson<{
                    title: string;
                    listName?: string;
                    due?: string;
                    priority?: "none" | "low" | "medium" | "high";
                    notes?: string;
                }>(req);
                const result = await addTodo({
                    title: body.title,
                    listName: body.listName ?? "GenesisTools",
                    due: body.due,
                    priority: body.priority,
                    notes: body.notes,
                });
                sendJson(res, 200, result);
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/todos/complete") {
            try {
                const body = await readJson<{ reminderId: string }>(req);
                await completeTodo(body.reminderId);
                sendJson(res, 200, { ok: true });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "DELETE" && url.pathname === "/api/todos") {
            try {
                const body = await readJson<{ reminderId: string }>(req);
                await deleteTodo(body.reminderId);
                sendJson(res, 200, { ok: true });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/obsidian/tree") {
            try {
                const { obsidianVault } = await getConfig();
                const entries = await listVault(obsidianVault);
                sendJson(res, 200, { entries });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname === "/api/obsidian/note") {
            const path = url.searchParams.get("path");

            if (!path) {
                sendJson(res, 400, { error: "missing ?path=" });
                return;
            }

            try {
                const { obsidianVault } = await getConfig();
                const source = await readNote(obsidianVault, path);
                const published = await listPublished();
                const publishedSlug = published.find((note) => note.vaultPath === path)?.slug ?? null;
                const rendered = renderMarkdown(source, {
                    resolveWikilink: (name) => {
                        const match = published.find((note) => {
                            const base = note.vaultPath.split("/").pop() ?? note.vaultPath;

                            return base.replace(/\.md$/, "") === name;
                        });

                        return match?.slug ?? null;
                    },
                });
                sendJson(res, 200, { source, html: rendered.html, publishedSlug });
            } catch (err) {
                sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/obsidian/publish") {
            try {
                const { path } = await readJson<{ path: string }>(req);
                const note = await publishNote(path);
                sendJson(res, 200, { note });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/obsidian/unpublish") {
            try {
                const { slug } = await readJson<{ slug: string }>(req);
                await unpublishNote(slug);
                const remaining = await listPublished();
                sendJson(res, 200, { remaining });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "GET" && url.pathname.startsWith("/share/")) {
            const slug = url.pathname.replace(/^\/share\//, "").replace(/\/.*/, "");

            if (!slug) {
                next();
                return;
            }

            try {
                const note = await findPublishedBySlug(slug);

                if (!note) {
                    res.statusCode = 404;
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.end("<!doctype html><meta charset=utf-8><title>Not found</title><h1>Not found</h1>");
                    return;
                }

                const { obsidianVault } = await getConfig();
                const source = await readNote(obsidianVault, note.vaultPath);
                const published = await listPublished();
                const rendered = renderMarkdown(source, {
                    resolveWikilink: (name) => {
                        const match = published.find((publishedNote) => {
                            const base = publishedNote.vaultPath.split("/").pop() ?? publishedNote.vaultPath;

                            return base.replace(/\.md$/, "") === name;
                        });

                        return match?.slug ?? null;
                    },
                });
                const title = (note.vaultPath.split("/").pop() ?? note.vaultPath).replace(/\.md$/, "");
                const page = renderSharePage({ title, rendered, sourcePath: note.vaultPath });
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(page);
            } catch (err) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end(err instanceof Error ? err.message : String(err));
            }

            return;
        }

        next();
    });
}
