import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { patchUiConfig } from "@app/yt/config.client";
import { useNavigate } from "@tanstack/react-router";
import { Cable, Server } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function FirstRunWizard() {
    const navigate = useNavigate();
    const [apiUrl, setApiUrl] = useState("http://localhost:9876");
    const [submitting, setSubmitting] = useState(false);

    async function onSubmit() {
        setSubmitting(true);
        try {
            await patchUiConfig({ apiBaseUrl: apiUrl, firstRunComplete: true });
            toast.success("Connected. Let's index some signal.");
            navigate({ to: "/" });
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="grid min-h-[72vh] place-items-center p-4">
            <Card className="yt-panel neon-border w-full max-w-xl overflow-hidden">
                <CardHeader className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
                            <Server className="size-6" />
                        </div>
                        <div>
                            <p className="font-mono text-xs uppercase tracking-[0.3em] text-secondary">First run</p>
                            <CardTitle className="text-2xl">Connect your API server</CardTitle>
                        </div>
                    </div>
                    <CardDescription className="text-base leading-7">
                        The local dashboard talks to the YouTube pipeline over HTTP. Keep the default for a local
                        server, or point at a remote tunnel.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="space-y-2">
                        <label
                            className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground"
                            htmlFor="api-url"
                        >
                            API Base URL
                        </label>
                        <Input
                            id="api-url"
                            value={apiUrl}
                            onChange={(event) => setApiUrl(event.target.value)}
                            placeholder="http://localhost:9876"
                        />
                    </div>
                    <Button
                        onClick={onSubmit}
                        disabled={submitting || !apiUrl.trim()}
                        className="btn-glow w-full gap-2"
                    >
                        <Cable className="size-4" />
                        {submitting ? "Saving…" : "Continue"}
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
