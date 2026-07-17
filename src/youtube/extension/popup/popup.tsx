import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { send } from "@ext/api.bridge";
import { ApiStatus } from "@ext/popup/components/api-status";
import { QuickActions } from "@ext/popup/components/quick-actions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";

const queryClient = new QueryClient();

function isLocalhost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Pull the YouTube video id out of a tab URL (`?v=` on /watch, or the /shorts/ path segment). Returns null for any non-YouTube-video URL. */
function extractVideoId(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    if (url.hostname !== "www.youtube.com" && url.hostname !== "youtube.com" && url.hostname !== "m.youtube.com") {
        return null;
    }

    const fromWatch = url.searchParams.get("v");
    if (fromWatch) {
        return fromWatch;
    }

    const shorts = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shorts) {
        return decodeURIComponent(shorts[1]);
    }

    return null;
}

/** The active tab's video id, or null when it isn't a YouTube video page. The manifest's youtube.com host permission (plus activeTab) exposes the tab URL. */
async function resolveActiveVideoId(): Promise<string | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
        return null;
    }

    return extractVideoId(tab.url);
}

/**
 * A non-localhost origin isn't in the manifest's static host_permissions, so
 * request it at runtime (from the Save click gesture). Returns "granted" when the
 * extension may talk to the origin, "denied" when the user rejected the prompt,
 * and "invalid-url" when the input didn't parse as a URL.
 */
async function ensureHostPermission(rawUrl: string): Promise<"granted" | "denied" | "invalid-url"> {
    let origin: string;
    try {
        const parsed = new URL(rawUrl);
        if (isLocalhost(parsed.hostname)) {
            return "granted";
        }
        origin = `${parsed.protocol}//${parsed.host}/*`;
    } catch {
        return "invalid-url";
    }

    if (await chrome.permissions.contains({ origins: [origin] })) {
        return "granted";
    }

    return (await chrome.permissions.request({ origins: [origin] })) ? "granted" : "denied";
}

function Popup() {
    const [apiUrl, setApiUrl] = useState("http://localhost:9876");
    const [serviceKey, setServiceKey] = useState("");
    const [status, setStatus] = useState<"unknown" | "ok" | "down">("unknown");
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [videoId, setVideoId] = useState<string | null>(null);

    useEffect(() => {
        send<{ apiBaseUrl: string; serviceKey?: string }>({ type: "config:get" })
            .then((config) => {
                setApiUrl(config.apiBaseUrl);
                setServiceKey(config.serviceKey ?? "");
            })
            .catch(() => setStatus("down"));
    }, []);

    useEffect(() => {
        void resolveActiveVideoId().then(setVideoId);
    }, []);

    async function checkHealth(): Promise<void> {
        setNote(null);
        const permission = await ensureHostPermission(apiUrl);
        if (permission === "invalid-url") {
            setNote("That doesn't look like a valid URL.");
            setStatus("down");
            return;
        }

        if (permission === "denied") {
            setNote("Permission for that origin was denied — the extension can't reach it.");
            setStatus("down");
            return;
        }

        try {
            const base = apiUrl.replace(/\/$/, "");
            const authHeaders: Record<string, string> = serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {};
            const res = await fetch(`${base}/api/v1/channels`, { headers: authHeaders });
            setStatus(res.ok ? "ok" : "down");
        } catch {
            setStatus("down");
        }
    }

    async function save(): Promise<void> {
        setBusy(true);
        setNote(null);
        try {
            const permission = await ensureHostPermission(apiUrl);
            if (permission === "invalid-url") {
                setNote("That doesn't look like a valid URL.");
                setStatus("down");
                return;
            }

            if (permission === "denied") {
                setNote("Permission for that origin was denied — the extension can't reach it.");
                setStatus("down");
                return;
            }

            await send({ type: "config:set", apiBaseUrl: apiUrl, serviceKey: serviceKey.trim() || undefined });
            await checkHealth();
        } catch (error) {
            setNote(error instanceof Error ? error.message : String(error));
            setStatus("down");
        } finally {
            setBusy(false);
        }
    }

    function openDashboard(): void {
        window.open(apiUrl.replace(/\/$/, ""), "_blank", "noopener,noreferrer");
    }

    function runAction(stages: Array<"metadata" | "captions" | "transcribe" | "summarize">): void {
        if (!videoId) {
            return;
        }

        setBusy(true);
        chrome.runtime
            .sendMessage({ type: "api:startPipeline", target: videoId, targetKind: "video", stages })
            .finally(() => setBusy(false));
    }

    return (
        <main className="cyberpunk space-y-4 p-4">
            <header className="flex items-start justify-between gap-3">
                <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-secondary">GenesisTools</p>
                    <h1 className="text-base font-semibold">YouTube</h1>
                </div>
                <ApiStatus status={status} />
            </header>
            <section className="space-y-2">
                <label className="text-xs text-muted-foreground" htmlFor="apiBaseUrl">
                    API base URL
                </label>
                <Input
                    id="apiBaseUrl"
                    value={apiUrl}
                    onChange={(event) => setApiUrl(event.target.value)}
                    placeholder="http://localhost:9876"
                />
            </section>
            <section className="space-y-2">
                <label className="text-xs text-muted-foreground" htmlFor="serviceKey">
                    Service key (for a hosted server)
                </label>
                <Input
                    id="serviceKey"
                    type="password"
                    value={serviceKey}
                    onChange={(event) => setServiceKey(event.target.value)}
                    placeholder="leave blank for localhost"
                />
            </section>
            {note ? <p className="text-xs text-destructive">{note}</p> : null}
            <div className="grid grid-cols-2 gap-2">
                <Button onClick={save} disabled={busy}>
                    Save
                </Button>
                <Button onClick={checkHealth} variant="secondary" disabled={busy}>
                    Test
                </Button>
            </div>
            <QuickActions
                onOpenDashboard={openDashboard}
                onTranscribe={() => runAction(["metadata", "captions", "transcribe"])}
                onSummarise={() => runAction(["metadata", "captions", "summarize"])}
                disabled={busy}
                videoAvailable={videoId !== null}
            />
        </main>
    );
}

createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <Popup />
        </QueryClientProvider>
    </StrictMode>
);
