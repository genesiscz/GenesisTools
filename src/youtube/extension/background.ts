// Native JSON only — SafeJSON pulls in esprima/comment-json (~150 kB) which
// balloons the MV3 service-worker cold-start to multi-second latency on every
// idle → wake cycle. Bodies here are our own plain objects, never comments.
import { startDevReload } from "@ext/dev-reload";
import type { ExtensionEvent, ExtensionRequest, ExtensionResponse } from "@ext/shared/messages";
import { getExtensionConfig, setExtensionConfig } from "@ext/shared/storage";

declare const __EXT_DEV_RELOAD__: boolean;

const ports = new Set<chrome.runtime.Port>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
        await reconnectWebsocket();
        return { ok: true, data: next };
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
                }),
            });
        case "api:askVideo":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/qa`, {
                method: "POST",
                body: JSON.stringify({
                    question: req.question,
                    topK: req.topK,
                    provider: req.provider,
                    model: req.model,
                }),
            });
        case "api:startPipeline":
            return apiCall(`${base}/api/v1/pipeline`, {
                method: "POST",
                body: JSON.stringify({ target: req.target, targetKind: req.targetKind, stages: req.stages }),
            });
        case "api:getJob":
            return apiCall(`${base}/api/v1/jobs/${req.id}`);
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
            try {
                const body = (await res.json()) as { error?: unknown };
                if (typeof body.error === "string" && body.error !== "") {
                    detail = body.error;
                }
            } catch {
                // non-JSON error body — fall back to status line
            }
            return { ok: false, error: detail !== "" ? detail : `${res.status} ${res.statusText}` };
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
    // service key rides as a query param (the server reads ?access_token=).
    const url = cfg.serviceKey ? `${base}?access_token=${encodeURIComponent(cfg.serviceKey)}` : base;

    try {
        ws = new WebSocket(url);
        ws.onopen = () => broadcast({ type: "ws:status", connected: true });
        ws.onmessage = (message) => {
            try {
                const event = JSON.parse(typeof message.data === "string" ? message.data : String(message.data));
                broadcast({ type: "job:event", event });
            } catch {}
        };
        ws.onclose = () => {
            broadcast({ type: "ws:status", connected: false });
            scheduleReconnect();
        };
        ws.onerror = () => scheduleReconnect();
    } catch {
        scheduleReconnect();
    }
}

function scheduleReconnect(): void {
    if (reconnectTimer !== null) {
        return;
    }

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectWebsocket();
    }, 5000);
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

// touch: 1784066216583
