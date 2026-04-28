import { SafeJSON } from "@app/utils/json";
import type { ExtensionEvent, ExtensionRequest, ExtensionResponse } from "@ext/shared/messages";
import { getExtensionConfig, setExtensionConfig } from "@ext/shared/storage";

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
        const next = await setExtensionConfig({ apiBaseUrl: req.apiBaseUrl });
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
                body: SafeJSON.stringify({ handles: [req.handle] }),
            });
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
        case "api:getSummary":
            return apiCall(
                `${base}/api/v1/videos/${encodeURIComponent(req.id)}/summary?mode=${encodeURIComponent(req.mode)}`
            );
        case "api:generateSummary":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/summary`, {
                method: "POST",
                body: SafeJSON.stringify({
                    mode: req.mode,
                    force: req.force,
                    provider: req.provider,
                    model: req.model,
                    targetBins: req.targetBins,
                }),
            });
        case "api:askVideo":
            return apiCall(`${base}/api/v1/videos/${encodeURIComponent(req.id)}/qa`, {
                method: "POST",
                body: SafeJSON.stringify({
                    question: req.question,
                    topK: req.topK,
                    provider: req.provider,
                    model: req.model,
                }),
            });
        case "api:startPipeline":
            return apiCall(`${base}/api/v1/pipeline`, {
                method: "POST",
                body: SafeJSON.stringify({ target: req.target, targetKind: req.targetKind, stages: req.stages }),
            });
        case "api:getJob":
            return apiCall(`${base}/api/v1/jobs/${req.id}`);
    }
}

async function apiCall(url: string, init: RequestInit = {}): Promise<ExtensionResponse> {
    try {
        const res = await fetch(url, {
            ...init,
            headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
        });
        if (!res.ok) {
            return { ok: false, error: `${res.status} ${res.statusText}` };
        }
        return { ok: true, data: await res.json() };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

async function reconnectWebsocket(): Promise<void> {
    if (ws) {
        ws.close();
        ws = null;
    }

    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const cfg = await getExtensionConfig();
    const url = `${cfg.apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/api/v1/events`;

    try {
        ws = new WebSocket(url);
        ws.onopen = () => broadcast({ type: "ws:status", connected: true });
        ws.onmessage = (message) => {
            try {
                const event = SafeJSON.parse(typeof message.data === "string" ? message.data : String(message.data));
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
