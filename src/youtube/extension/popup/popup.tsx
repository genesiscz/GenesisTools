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

function Popup() {
    const [apiUrl, setApiUrl] = useState("http://localhost:9876");
    const [status, setStatus] = useState<"unknown" | "ok" | "down">("unknown");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        send<{ apiBaseUrl: string }>({ type: "config:get" })
            .then((config) => setApiUrl(config.apiBaseUrl))
            .catch(() => setStatus("down"));
    }, []);

    async function checkHealth(): Promise<void> {
        try {
            const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v1/healthz`);
            setStatus(res.ok ? "ok" : "down");
        } catch {
            setStatus("down");
        }
    }

    async function save(): Promise<void> {
        setBusy(true);
        try {
            await send({ type: "config:set", apiBaseUrl: apiUrl });
            await checkHealth();
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
