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

    useEffect(() => {
        send<{ apiBaseUrl: string; serviceKey?: string }>({ type: "config:get" })
            .then((config) => {
                setApiUrl(config.apiBaseUrl);
                setServiceKey(config.serviceKey ?? "");
            })
            .catch(() => setStatus("down"));
    }, []);

    async function checkHealth(): Promise<void> {
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
        chrome.runtime.sendMessage({ type: "config:get" }).then(() => {
            window.open(apiUrl.replace(/\/$/, ""), "_blank", "noopener,noreferrer");
        });
    }

    function runAction(stages: Array<"metadata" | "captions" | "transcribe" | "summarize">): void {
        setBusy(true);
        chrome.runtime
            .sendMessage({ type: "api:startPipeline", target: "current", targetKind: "video", stages })
            .finally(() => setBusy(false));
    }

    return (
        <main className="cyberpunk space-y-4 p-4">
            <header className="flex items-start justify-between gap-3">
                <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-secondary">GenesisTools</p>
                    <h1 className="text-base font-semibold">YouTube Pipeline</h1>
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
