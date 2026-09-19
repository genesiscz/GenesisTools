import type { StoredVisualCapture, StoredVisualChoice } from "@app/control/lib/decision/visual-store";
import { Badge, Callout, JsonView } from "@artifact/kit";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Camera, MousePointer2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./client";

export function VisualLab() {
    const [app, setApp] = useState("Brave Browser");
    const [windowIndex, setWindowIndex] = useState("0");
    const [crop, setCrop] = useState("");
    const [intent, setIntent] = useState("");
    const [chooser, setChooser] = useState("exact");
    const [capture, setCapture] = useState<StoredVisualCapture | null>(null);
    const [choice, setChoice] = useState<StoredVisualChoice | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [action, setAction] = useState<unknown>(null);
    const [expired, setExpired] = useState(false);
    const [consumed, setConsumed] = useState(false);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const pending = useRef<AbortController | null>(null);
    useEffect(() => () => pending.current?.abort(), []);
    useEffect(() => {
        if (!capture) {
            return;
        }
        setExpired(Date.now() >= capture.actionExpiresAt);
        const timer = setTimeout(() => setExpired(true), Math.max(0, capture.actionExpiresAt - Date.now()));
        return () => clearTimeout(timer);
    }, [capture]);
    const run = async (mode: "capture" | "choose" | "click") => {
        const controller = new AbortController();
        pending.current = controller;
        setBusy(mode);
        setError("");
        try {
            if (mode === "capture") {
                setChoice(null);
                setAction(null);
                setSelected(null);
                setConsumed(false);
                const next = await api<StoredVisualCapture>({
                    route: "/control/visual/capture",
                    body: {
                        app,
                        windowIndex: Number(windowIndex),
                        ...(crop.trim() ? { crop: crop.trim() } : {}),
                        width: 1400,
                    },
                    signal: controller.signal,
                });
                setCapture(next);
            } else if (mode === "choose" && capture) {
                const next = await api<StoredVisualChoice>({
                    route: "/control/visual/choose",
                    body: { id: capture.id, intent, chooser },
                    signal: controller.signal,
                });
                setChoice(next);
                setSelected(next.selected?.id ?? null);
            } else if (mode === "click" && capture && selected) {
                setConsumed(true);
                setAction(
                    await api({
                        route: "/control/visual/click",
                        body: { id: capture.id, regionId: selected },
                        signal: controller.signal,
                    })
                );
            }
        } catch (cause) {
            setError(controller.signal.aborted ? "Operation stopped." : errorMessage(cause));
        } finally {
            setBusy("");
            pending.current = null;
        }
    };
    return (
        <div className="space-y-5">
            <Card variant="wow-static" accent="cyan">
                <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <CardTitle>Native OCR grounding</CardTitle>
                        <Badge>Live desktop · explicit click</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                        Capture one window, inspect its text regions, then select an exact match or ask Jev. A click
                        uses the captured pixels and expires after 30 seconds.
                    </p>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-[2fr_1fr_2fr]">
                        <label className="jev-field">
                            App name or PID
                            <Input
                                aria-label="Visual app"
                                value={app}
                                onChange={(event) => setApp(event.target.value)}
                                disabled={Boolean(busy)}
                            />
                        </label>
                        <label className="jev-field">
                            Window index
                            <Input
                                aria-label="Visual window index"
                                type="number"
                                min="0"
                                value={windowIndex}
                                onChange={(event) => setWindowIndex(event.target.value)}
                                disabled={Boolean(busy)}
                            />
                        </label>
                        <label className="jev-field">
                            OCR crop (optional source pixels)
                            <Input
                                aria-label="Visual crop"
                                placeholder="x,y,width,height"
                                value={crop}
                                onChange={(event) => setCrop(event.target.value)}
                                disabled={Boolean(busy)}
                            />
                        </label>
                    </div>
                    <div className="flex flex-wrap gap-3">
                        <Button
                            variant="brand"
                            disabled={Boolean(busy) || !app.trim()}
                            onClick={() => void run("capture")}
                        >
                            <Camera size={14} />
                            {busy === "capture" ? "Capturing…" : "Capture window"}
                        </Button>
                        {busy && (
                            <Button variant="outline" onClick={() => pending.current?.abort()}>
                                Stop
                            </Button>
                        )}
                        <p className="self-center text-xs text-muted-foreground">
                            Local Vision OCR · no download · no AI call for capture
                        </p>
                    </div>
                </CardContent>
            </Card>
            {error && (
                <div role="alert">
                    <Callout tone="err" title="Operation stopped">
                        {error}
                    </Callout>
                </div>
            )}
            {capture && (
                <>
                    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
                        <Card variant="default">
                            <CardHeader>
                                <CardTitle className="text-base">{capture.window.title || capture.app}</CardTitle>
                                <p className="text-xs text-muted-foreground">
                                    {capture.regions.length} text regions · {capture.width} × {capture.height} pixels ·{" "}
                                    {expired
                                        ? "Action evidence expired"
                                        : consumed
                                          ? "Capture consumed"
                                          : "Click evidence available"}
                                </p>
                            </CardHeader>
                            <CardContent>
                                <div className="relative overflow-hidden rounded-lg border border-border">
                                    <img
                                        src={capture.imageUrl}
                                        alt={`Native capture of ${capture.window.title || capture.app}`}
                                        className="block h-auto w-full"
                                    />
                                    {capture.regions.map((region) => (
                                        <button
                                            type="button"
                                            key={region.id}
                                            title={region.text}
                                            aria-label={`Region ${region.id}: ${region.text}`}
                                            onClick={() => {
                                                setSelected(region.id);
                                                setChoice(null);
                                            }}
                                            className={`absolute border-2 transition-colors ${selected === region.id ? "border-primary bg-primary/25" : "border-accent/60 hover:bg-accent/20"}`}
                                            style={{
                                                left: `${(100 * region.source.x) / capture.width}%`,
                                                top: `${(100 * region.source.y) / capture.height}%`,
                                                width: `${(100 * region.source.width) / capture.width}%`,
                                                height: `${(100 * region.source.height) / capture.height}%`,
                                            }}
                                        />
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                        <Card variant="default">
                            <CardHeader>
                                <CardTitle className="text-base">Choose an observed target</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <label className="jev-field">
                                    Target intent
                                    <Input
                                        aria-label="Visual target intent"
                                        value={intent}
                                        onChange={(event) => setIntent(event.target.value)}
                                        placeholder="Open preferences"
                                    />
                                </label>
                                <label className="jev-field">
                                    Chooser
                                    <select
                                        aria-label="Visual chooser"
                                        value={chooser}
                                        className="rounded border border-border bg-background p-2"
                                        onChange={(event) => setChooser(event.target.value)}
                                    >
                                        <option value="exact">Exact text · no AI</option>
                                        <option value="jev">Jev · current provider</option>
                                        <option value="auto">Auto · exact then Jev</option>
                                    </select>
                                </label>
                                <Button
                                    variant="outline"
                                    disabled={Boolean(busy) || !intent.trim() || consumed || expired}
                                    onClick={() => void run("choose")}
                                >
                                    {busy === "choose" ? "Choosing…" : "Choose target"}
                                </Button>
                                <div className="max-h-64 space-y-1 overflow-auto">
                                    {capture.regions.map((region) => (
                                        <button
                                            type="button"
                                            key={region.id}
                                            onClick={() => {
                                                setSelected(region.id);
                                                setChoice(null);
                                            }}
                                            className={`block w-full rounded border p-2 text-left text-xs ${selected === region.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}
                                        >
                                            <span className="font-mono text-muted-foreground">{region.id}</span>{" "}
                                            {region.text}
                                            <span className="ml-2 text-muted-foreground">
                                                {Math.round(region.confidence * 100)}%
                                            </span>
                                        </button>
                                    ))}
                                </div>
                                <Button
                                    variant="brand"
                                    disabled={Boolean(busy) || !selected || consumed || expired}
                                    onClick={() => void run("click")}
                                >
                                    <MousePointer2 size={14} />
                                    Click selected region
                                </Button>
                                <p className="text-xs text-muted-foreground">
                                    {expired
                                        ? "Capture again to act on fresh pixels."
                                        : "The native backend checks pixel content, app instance, window bounds and one-use ownership immediately before clicking."}
                                </p>
                                {choice && (
                                    <details open>
                                        <summary className="cursor-pointer text-sm">Choice evidence</summary>
                                        <JsonView value={choice} />
                                    </details>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                    {action !== null && (
                        <Callout tone="info" title="Native action result">
                            <p className="mb-3">
                                Dispatch and task completion are separate. Capture again to inspect the result.
                            </p>
                            <JsonView value={action} />
                        </Callout>
                    )}
                </>
            )}
        </div>
    );
}
