import type { WaitReplayResult } from "@app/control/lib/decision/wait-replay";
import { Badge, Callout, JsonView } from "@artifact/kit";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./client";

export function WaitLab() {
    const [cases, setCases] = useState<Array<{ id: string; title: string }>>([]);
    const [selected, setSelected] = useState("ready");
    const [chooser, setChooser] = useState("oracle");
    const [result, setResult] = useState<WaitReplayResult | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        void api<Array<{ id: string; title: string }>>({ route: "/control/wait-cases", signal: controller.signal })
            .then(setCases)
            .catch((cause) => {
                if (!controller.signal.aborted) {
                    setError(errorMessage(cause));
                }
            });
        return () => {
            controller.abort();
            pending.current?.abort();
        };
    }, []);
    const run = async () => {
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setError("");
        setResult(null);
        try {
            const next = await api<WaitReplayResult>({
                route: "/control/wait-replay",
                body: { id: selected, chooser },
                signal: controller.signal,
            });
            if (!controller.signal.aborted) {
                setResult(next);
            }
        } catch (cause) {
            setError(controller.signal.aborted ? "Wait replay cancelled." : errorMessage(cause));
        } finally {
            setBusy(false);
            pending.current = null;
        }
    };
    return (
        <Card variant="wow-static" accent="cyan">
            <CardHeader>
                <CardTitle>Semantic waits</CardTitle>
                <p className="text-sm text-muted-foreground">
                    Replay progress on a virtual clock. Unchanged evidence does not call the model again.
                </p>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="jev-field">
                        Scenario
                        <select
                            aria-label="Wait scenario"
                            className="rounded border border-border bg-background p-2"
                            value={selected}
                            disabled={busy}
                            onChange={(event) => setSelected(event.target.value)}
                        >
                            {cases.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.title}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="jev-field">
                        Wait evaluator
                        <select
                            aria-label="Wait evaluator"
                            className="rounded border border-border bg-background p-2"
                            value={chooser}
                            disabled={busy}
                            onChange={(event) => setChooser(event.target.value)}
                        >
                            <option value="oracle">Fixture oracle · no model</option>
                            <option value="jev">Jev · current provider</option>
                        </select>
                    </label>
                    <Button variant="cyber" disabled={busy} onClick={() => void run()}>
                        Replay wait
                    </Button>
                    {busy && (
                        <Button variant="outline" onClick={() => pending.current?.abort()}>
                            Cancel wait
                        </Button>
                    )}
                </div>
                {error && (
                    <Callout tone="warn" title="Wait replay">
                        {error}
                    </Callout>
                )}
                {result && (
                    <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                            <Badge>{result.status}</Badge>
                            <Badge>{result.metrics.elapsedMs} ms virtual time</Badge>
                            <Badge>{result.paidRequests} model requests</Badge>
                            <Badge>{result.metrics.unchanged} unchanged observations</Badge>
                        </div>
                        <p className="text-sm">{result.reason}</p>
                        <ol className="space-y-2 border-l border-border pl-4">
                            {result.events.map((event, index) => (
                                <li key={`${event.atMs}-${index}`} className="text-sm">
                                    <span className="font-mono text-muted-foreground">{event.atMs} ms</span>{" "}
                                    <strong>{event.state}</strong>
                                    {" · "}
                                    {event.evidence.map((item) => item.value || item.label).join("; ")}
                                </li>
                            ))}
                        </ol>
                        <details>
                            <summary className="cursor-pointer text-sm text-muted-foreground">
                                View classifications
                            </summary>
                            <JsonView
                                value={result.events.map(({ atMs, probabilities, evidenceDecision }) => ({
                                    atMs,
                                    probabilities,
                                    evidenceDecision,
                                }))}
                            />
                        </details>
                        <p className="text-xs text-muted-foreground">
                            Fixture replay only; no desktop actions. {result.wallMs.toFixed(0)} ms actual runtime.
                            Oracle results verify the pipeline, not model accuracy.
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
