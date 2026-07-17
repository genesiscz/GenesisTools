// Native JSON only — SafeJSON pulls in esprima/comment-json (~150 kB) which
// balloons the MV3 service-worker cold-start to multi-second latency on every
// idle → wake cycle. Bodies here are our own plain objects, never comments.
import type { JobEvent } from "@app/youtube/lib/jobs.types";
import { startDevReload } from "@ext/dev-reload";
import type { ExtensionEvent, ExtensionRequest, ExtensionResponse } from "@ext/shared/messages";
import { getExtensionConfig, setExtensionConfig } from "@ext/shared/storage";

declare const __EXT_DEV_RELOAD__: boolean;

// Job events the server emits on the events socket. Everything else on that
// socket (hello / pong / subscribed control frames) is protocol chatter the
// panel must never see as a job event. Mirrors PIPELINE_EVENTS in
// src/youtube/lib/server/websocket.ts.
const PIPELINE_EVENT_TYPES = new Set<JobEvent["type"]>([
    "job:created",
    "job:started",
    "stage:started",
    "stage:progress",
    "stage:completed",
    "summary:partial",
    "job:completed",
    "job:failed",
    "job:cancelled",
]);

// Reconnect backoff: exponential from 5s, capped at 5min, reset on a live
// connection (ws.onopen) so a brief blip retries fast while a long outage
// backs off instead of hammering a dead server every 5s.
const RECONNECT_BASE_MS = 5000;
const RECONNECT_CAP_MS = 5 * 60_000;

// nav:openWatch interpolates the id into a youtube.com/watch URL opened in a
// new tab. It's already encodeURIComponent'd (can't break out), but validate
// the shape so an arbitrary string can't open a bogus YouTube URL.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/;

const ports = new Set<chrome.runtime.Port>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempts = 0;

chrome.runtime.onConnect.addListener((port) => {
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
});

chrome.runtime.onMessage.addListener((req: ExtensionRequest, _sender, sendResponse) => {
    handleRequest(req).then(sendResponse, (error) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
});

export async function handleRequest(req: ExtensionRequest): Promise<ExtensionResponse> {
    if (req.type === "config:get") {
        return { ok: true, data: await getExtensionConfig() };
    }

    if (req.type === "config:set") {
        const next = await setExtensionConfig({ apiBaseUrl: req.apiBaseUrl, serviceKey: req.serviceKey });
        // New server target — retry from the base delay rather than inheriting
        // the previous target's backoff.
        reconnectAttempts = 0;
        await reconnectWebsocket();
        return { ok: true, data: next };
    }

    if (req.type === "nav:openWatch") {
        if (!VIDEO_ID_PATTERN.test(req.id)) {
            return { ok: false, error: "invalid video id" };
        }

        const seconds = Math.max(0, Math.floor(req.t));
        await chrome.tabs.create({
            url: `https://www.youtube.com/watch?v=${encodeURIComponent(req.id)}&t=${seconds}s`,
        });
        return { ok: true, data: { opened: true } };
    }

    const cfg = await getExtensionConfig();
    const base = cfg.apiBaseUrl.replace(/\/$/, "");

    switch (req.type) {
        case "api:listChannels":
            return apiCall(`${base}/api/v1/channels`);
        case "api:addChannel":
            return apiCall(`${base}/api/v1/channels`, {
                method: "POST",
                body: JSON.stringify({ handles: [req.handle] }),
            });
        case "api:listVideos": {
            const query = new URLSearchParams();
            if (req.channel) {
                query.set("channel", req.channel);
            }
            if (req.since) {
                query.set("since", req.since);
            }
            if (typeof req.limit === "number") {
                query.set("limit", String(req.limit));
            }
            if (req.includeShorts) {
                query.set("includeShorts", "true");
            }
            const suffix = query.toString() ? `?${query.toString()}` : "";
            return apiCall(`${base}/api/v1/videos${suffix}`);
        }
        case "api:getVideo":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}`);
        case "api:getTranscript": {
            const query = new URLSearchParams();
            if (req.lang) {
                query.set("lang", req.lang);
            }
            if (req.source) {
                query.set("source", req.source);
            }
            const suffix = query.toString() ? `?${query.toString()}` : "";
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/transcript${suffix}`);
        }
        case "api:getComments":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/comments`);
        case "api:getSummary":
            return apiCall(
                `${base}/api/v1/videos/${encodeURIComponent(req.id)}/summary?mode=${encodeURIComponent(req.mode)}`
            );
        case "api:generateSummary":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/summary`, {
                method: "POST",
                body: JSON.stringify({
                    mode: req.mode,
                    force: req.force,
                    provider: req.provider,
                    model: req.model,
                    targetBins: req.targetBins,
                    tone: req.tone,
                    format: req.format,
                    length: req.length,
                    presetId: req.presetId,
                    lang: req.lang,
                }),
            });
        case "api:translateTranscript":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/transcript/translate`, {
                method: "POST",
                body: JSON.stringify({ lang: req.lang }),
            });
        case "api:patchMe":
            return apiCall(`${base}/api/v1/users/me`, {
                method: "PATCH",
                body: JSON.stringify({ outputLang: req.outputLang, ttsVoice: req.ttsVoice }),
            });
        case "api:generateSummaryAudio":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/summary/audio`, {
                method: "POST",
                body: JSON.stringify({ voice: req.voice }),
            });
        case "api:setSpeakers":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/speakers`, {
                method: "PUT",
                body: JSON.stringify({ speakers: req.speakers }),
            });
        case "api:askVideo":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/qa`, {
                method: "POST",
                body: JSON.stringify({
                    question: req.question,
                    topK: req.topK,
                    provider: req.provider,
                    model: req.model,
                    presetId: req.presetId,
                    sources: req.sources,
                    scope: req.scope,
                }),
            });
        case "api:startPipeline":
            return apiCall(`${base}/api/v1/pipeline`, {
                method: "POST",
                body: JSON.stringify({ target: req.target, targetKind: req.targetKind, stages: req.stages }),
            });
        case "api:getJob":
            return apiCall(`${base}/api/v1/jobs/${req.id}`);
        case "api:queueStats":
            return apiCall(`${base}/api/v1/jobs/queue`);
        case "api:listModels":
            return apiCall(`${base}/api/v1/models`);
        case "api:estimate": {
            const query = new URLSearchParams({ mode: req.mode });
            if (req.provider) {
                query.set("provider", req.provider);
            }
            if (req.model) {
                query.set("model", req.model);
            }
            if (req.lang) {
                query.set("lang", req.lang);
            }
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/estimate?${query.toString()}`);
        }
        case "api:register":
        case "api:login": {
            const action = req.type === "api:register" ? "register" : "login";
            const res = await apiCall(`${base}/api/v1/users/${action}`, {
                method: "POST",
                body: JSON.stringify({ email: req.email, password: req.password }),
            });
            if (res.ok) {
                const data = res.data as { token?: string };
                if (typeof data.token === "string") {
                    await setExtensionConfig({ userToken: data.token });
                }
            }
            return res;
        }
        case "api:logout":
            await setExtensionConfig({ userToken: undefined });
            return { ok: true, data: { ok: true } };
        case "api:me":
            return apiCall(`${base}/api/v1/users/me`);
        case "api:topup":
            return apiCall(`${base}/api/v1/users/topup`, {
                method: "POST",
                body: JSON.stringify(typeof req.amount === "number" ? { amount: req.amount } : {}),
            });
        case "api:reportEstimate":
            return apiCall(`${base}/api/v1/reports/estimate`, {
                method: "POST",
                body: JSON.stringify({ videoIds: req.videoIds }),
            });
        case "api:createReport":
            return apiCall(`${base}/api/v1/reports`, {
                method: "POST",
                body: JSON.stringify({ videoIds: req.videoIds, title: req.title }),
            });
        case "api:getReport":
            return apiCall(`${base}/api/v1/reports/${req.id}`);
        case "api:qaHistory": {
            const query = new URLSearchParams();
            if (req.id) {
                query.set("video", req.id);
            }
            if (typeof req.limit === "number") {
                query.set("limit", String(req.limit));
            }
            const suffix = query.toString() ? `?${query.toString()}` : "";
            return apiCall(`${base}/api/v1/users/qa-history${suffix}`);
        }
        case "api:ledger": {
            const query = new URLSearchParams();
            if (typeof req.before === "number") {
                query.set("before", String(req.before));
            }
            if (typeof req.limit === "number") {
                query.set("limit", String(req.limit));
            }
            const suffix = query.toString() ? `?${query.toString()}` : "";
            return apiCall(`${base}/api/v1/users/ledger${suffix}`);
        }
        case "api:usageSummary":
            return apiCall(`${base}/api/v1/users/usage-summary`);
        case "api:checkout": {
            const res = await apiCall(`${base}/api/v1/users/checkout`, {
                method: "POST",
                body: JSON.stringify({ packId: req.packId }),
            });
            // Checkout opens in a new browser tab — the panel must never iframe
            // Stripe's hosted page.
            if (res.ok) {
                const data = res.data as { url?: string };
                if (typeof data.url === "string") {
                    await chrome.tabs.create({ url: data.url });
                }
            }
            return res;
        }
        case "api:createShare":
            return apiCall(`${base}/api/v1/shares`, {
                method: "POST",
                body: JSON.stringify({
                    kind: req.kind,
                    videoId: req.videoId,
                    mode: req.mode,
                    qaHistoryId: req.qaHistoryId,
                }),
            });
        case "api:listShares":
            return apiCall(`${base}/api/v1/shares`);
        case "api:revokeShare":
            return apiCall(`${base}/api/v1/shares/${encodeURIComponent(req.slug)}`, { method: "DELETE" });
        case "api:listPresets": {
            const suffix = req.kind ? `?kind=${encodeURIComponent(req.kind)}` : "";
            return apiCall(`${base}/api/v1/users/presets${suffix}`);
        }
        case "api:createPreset":
            return apiCall(`${base}/api/v1/users/presets`, {
                method: "POST",
                body: JSON.stringify({ name: req.name, kind: req.kind, instructions: req.instructions }),
            });
        case "api:updatePreset":
            return apiCall(`${base}/api/v1/users/presets/${req.id}`, {
                method: "PUT",
                body: JSON.stringify({ name: req.name, instructions: req.instructions }),
            });
        case "api:deletePreset":
            return apiCall(`${base}/api/v1/users/presets/${req.id}`, { method: "DELETE" });
        default: {
            // Exhaustiveness guard: every ExtensionRequest above returns, so a
            // new variant added without a case fails this assignment at compile
            // time instead of silently returning undefined at runtime.
            const unhandled: never = req;
            return { ok: false, error: `unhandled request: ${String((unhandled as ExtensionRequest).type)}` };
        }
    }
}

async function apiCall(url: string, init: RequestInit = {}): Promise<ExtensionResponse> {
    const { serviceKey, userToken } = await getExtensionConfig();
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    // The user token wins over a configured service key — user routes need
    // the ytu_ identity, and the server ignores non-ytu_ tokens there.
    const bearer = userToken ?? serviceKey;
    if (bearer) {
        headers.set("Authorization", `Bearer ${bearer}`);
    }

    try {
        const res = await fetch(url, {
            ...init,
            headers,
        });
        if (!res.ok) {
            let detail = "";
            let code: string | undefined;
            try {
                const body = (await res.json()) as { error?: unknown; code?: unknown };
                if (typeof body.error === "string" && body.error !== "") {
                    detail = body.error;
                }
                if (typeof body.code === "string" && body.code !== "") {
                    code = body.code;
                }
            } catch {
                // non-JSON error body — fall back to status line
            }
            return { ok: false, error: detail !== "" ? detail : `${res.status} ${res.statusText}`, ...(code ? { code } : {}) };
        }
        return { ok: true, data: await res.json() };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

async function reconnectWebsocket(): Promise<void> {
    if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
    }

    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const cfg = await getExtensionConfig();
    const base = `${cfg.apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/api/v1/events`;
    // Browsers can't set an Authorization header on a WS handshake, so the
    // token rides as a query param. The USER token wins: the server scopes the
    // socket to that user's jobs; the service key would receive everyone's.
    const token = cfg.userToken ?? cfg.serviceKey;
    const url = token ? `${base}?access_token=${encodeURIComponent(token)}` : base;

    try {
        ws = new WebSocket(url);
        ws.onopen = () => {
            reconnectAttempts = 0;
            broadcast({ type: "ws:status", connected: true });
            // Chrome ≥116 extends the MV3 service-worker lifetime on WS
            // activity — without this 20s ping the SW idles out after ~30s,
            // the socket dies with it, and job events (progress, completion
            // invalidations) silently stop reaching the panel. Same trick
            // dev-reload uses.
            if (pingTimer !== null) {
                clearInterval(pingTimer);
            }
            pingTimer = setInterval(() => {
                if (ws?.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "ping" }));
                }
            }, 20_000);
        };
        ws.onmessage = (message) => {
            try {
                const raw = typeof message.data === "string" ? message.data : String(message.data);
                const event = JSON.parse(raw) as { type?: unknown };

                if (typeof event.type !== "string" || !PIPELINE_EVENT_TYPES.has(event.type as JobEvent["type"])) {
                    return;
                }

                broadcast({ type: "job:event", event: event as JobEvent });
            } catch (error) {
                console.debug("[genesis-yt] failed to parse events WS frame", error);
            }
        };
        ws.onclose = () => {
            if (pingTimer !== null) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            broadcast({ type: "ws:status", connected: false });
            scheduleReconnect();
        };
        ws.onerror = () => scheduleReconnect();
    } catch (error) {
        console.debug("[genesis-yt] events WebSocket construction failed", error);
        scheduleReconnect();
    }
}

function scheduleReconnect(): void {
    if (reconnectTimer !== null) {
        return;
    }

    const backoff = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
    // Up to 25% jitter so many extensions reconnecting to a recovered server
    // don't stampede in lockstep.
    const delay = backoff + Math.random() * backoff * 0.25;
    reconnectAttempts += 1;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectWebsocket();
    }, delay);
}

function broadcast(event: ExtensionEvent): void {
    for (const port of ports) {
        try {
            port.postMessage(event);
        } catch {
            ports.delete(port);
        }
    }
}

reconnectWebsocket();

if (typeof __EXT_DEV_RELOAD__ !== "undefined" && __EXT_DEV_RELOAD__) {
    startDevReload();
}
