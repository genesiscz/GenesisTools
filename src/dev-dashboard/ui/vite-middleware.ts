import type { IncomingMessage, ServerResponse } from "node:http";
import { focusCmuxPane } from "@app/cmux/lib/controls";
import { getConfig, getOrCreateDashboardAuth } from "@app/dev-dashboard/config";
import { isCompleteAuthConfig, verifyBasicAuthHeader } from "@app/dev-dashboard/lib/auth";
import { getCachedSnapshot, startPolling } from "@app/dev-dashboard/lib/cmux/poller";
import { getCurrentUsage, getUsageHistory } from "@app/dev-dashboard/lib/claude-usage/aggregator";
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
import { configureRetention, getCachedPulse, getSeries, startPulsePolling } from "@app/dev-dashboard/lib/system/poller";
import { addTodo, completeTodo, deleteTodo, listTodos } from "@app/dev-dashboard/lib/todos/service";
import { killTtyd, listTtyd, spawnTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { fetchWeather } from "@app/dev-dashboard/lib/weather/client";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Connect } from "vite";

let loggedGeneratedPassword = false;

getConfig()
    .then(({ cmuxPollIntervalMs }) => startPolling(cmuxPollIntervalMs))
    .catch(() => startPolling(2000));

getConfig()
    .then(({ pulse }) => {
        configureRetention(pulse.retentionHours);
        startPulsePolling(pulse.pollIntervalMs);
    })
    .catch(() => startPulsePolling(5000));

async function readJson<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString("utf8") || "{}";

    return SafeJSON.parse(raw) as T;
}

function sendJson(res: ServerResponse, status: number, body: object): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(SafeJSON.stringify(body));
}

async function requireDashboardAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === "GET" && url.pathname.startsWith("/share/")) {
        return true;
    }

    const provision = await getOrCreateDashboardAuth();

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

    if (verifyBasicAuthHeader(req.headers.authorization ?? null, provision.auth)) {
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

        if (req.method === "GET" && url.pathname === "/api/ttyd/list") {
            sendJson(res, 200, { sessions: await listTtyd() });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/ttyd/spawn") {
            try {
                const body = await readJson<{ command?: string; cwd?: string }>(req);
                const session = await spawnTtyd(body);
                sendJson(res, 200, { session });
            } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }

            return;
        }

        if (req.method === "POST" && url.pathname === "/api/ttyd/kill") {
            try {
                const body = await readJson<{ id: string }>(req);
                const ok = await killTtyd(body.id);
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
            const bucket = url.searchParams.get("bucket") ?? "five_hour";
            const minutes = Number.parseInt(url.searchParams.get("minutes") ?? "1440", 10);

            try {
                sendJson(
                    res,
                    200,
                    getUsageHistory({ account, bucket, minutes: Number.isFinite(minutes) ? minutes : 1440 })
                );
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
            const { obsidianVault } = await getConfig();

            try {
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

            const { obsidianVault } = await getConfig();

            try {
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
