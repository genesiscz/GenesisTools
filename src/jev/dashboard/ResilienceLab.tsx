import type { ChooserComparison } from "@app/control/lib/decision/chooser-replay";
import type { ResilienceReplay } from "@app/control/lib/decision/resilience-replay";
import { Badge, Callout, JsonView } from "@artifact/kit";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./client";

const caseOptions = {
    recovery: [
        ["stale", "Stale target"],
        ["unknown", "Unknown delivery"],
        ["permission", "Permission refusal"],
        ["cap", "Recovery cap"],
    ],
    workflow: [
        ["reordered", "Reordered fields"],
        ["renamed", "Renamed target"],
        ["ambiguous", "Ambiguous selector"],
    ],
};
export function ResilienceLab({ kind }: { kind: "recovery" | "workflow" }) {
    const [selected, setSelected] = useState(caseOptions[kind][0][0]);
    const [jev, setJev] = useState(false);
    const [result, setResult] = useState<ResilienceReplay | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef<AbortController | null>(null);
    useEffect(() => () => pending.current?.abort(), []);
    const run = async () => {
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setError("");
        setResult(null);
        try {
            setResult(
                await api<ResilienceReplay>({
                    route: "/control/resilience-replay",
                    body: { id: selected, chooser: jev ? "jev" : "oracle" },
                    signal: controller.signal,
                })
            );
        } catch (cause) {
            setError(controller.signal.aborted ? "Replay stopped." : errorMessage(cause));
        } finally {
            setBusy(false);
            pending.current = null;
        }
    };
    return (
        <Card variant="wow-static" accent="cyan">
            <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <CardTitle>{kind === "recovery" ? "Bounded recovery" : "Resilient workflows"}</CardTitle>
                    <Badge>In-memory fixture · no desktop actions</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                    {kind === "recovery"
                        ? "Refusals before dispatch can trigger a fresh observation. Unknown delivery, permissions, and exhausted budgets stop the run."
                        : "Keep actions and supplied values fixed. Exact selectors survive reordering; an enabled Jev chooser can repair a missing target."}
                </p>
            </CardHeader>
            <CardContent className="space-y-5">
                <div className="flex flex-wrap items-end gap-4">
                    <label className="jev-field">
                        Scenario
                        <select
                            aria-label={`${kind} scenario`}
                            value={selected}
                            disabled={busy}
                            className="rounded border border-border bg-background p-2"
                            onChange={(event) => {
                                setSelected(event.target.value);
                                setResult(null);
                            }}
                        >
                            {caseOptions[kind].map(([id, title]) => (
                                <option key={id} value={id}>
                                    {title}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={jev}
                            disabled={busy}
                            onChange={(event) => setJev(event.target.checked)}
                        />
                        Use Jev · current provider
                    </label>
                    <Button variant="brand" disabled={busy} onClick={() => void run()}>
                        <Play size={14} />
                        Run {kind} replay
                    </Button>
                    {busy && (
                        <Button variant="outline" onClick={() => pending.current?.abort()}>
                            <Square size={14} />
                            Stop
                        </Button>
                    )}
                </div>
                {error && (
                    <div role="alert">
                        <Callout tone="err" title="Replay stopped">
                            {error}
                        </Callout>
                    </div>
                )}
                {result && (
                    <>
                        <div className="grid gap-3 sm:grid-cols-3">
                            {[
                                ["Outcome", result.result.status],
                                ["Dispatch attempts", result.dispatchAttempts],
                                ["Paid requests", result.paidRequests],
                            ].map(([label, value]) => (
                                <div key={label} className="rounded-lg border border-border bg-muted/30 p-4">
                                    <p className="text-xs text-muted-foreground">{label}</p>
                                    <p className="mt-1 text-xl font-semibold">{value}</p>
                                </div>
                            ))}
                        </div>
                        <p className="text-sm">{result.result.reason}</p>
                        <ol className="space-y-2">
                            {result.events.map((event, index) => (
                                <li key={index} className="flex gap-3 text-sm">
                                    <span className="text-muted-foreground">{index + 1}.</span>
                                    <Badge>{event.kind}</Badge>
                                    <span>{event.detail}</span>
                                </li>
                            ))}
                        </ol>
                        <p className="text-xs text-muted-foreground">{result.note}</p>
                        <details>
                            <summary className="cursor-pointer text-sm">Decision evidence and budgets</summary>
                            <JsonView value={result.result} />
                        </details>
                    </>
                )}
                <p className="text-xs text-muted-foreground">
                    <code>
                        tools jev control resilience-replay {selected}
                        {jev ? " --jev" : ""}
                    </code>
                </p>
            </CardContent>
        </Card>
    );
}
export function ChooserLab() {
    const [jev, setJev] = useState(false);
    const [result, setResult] = useState<ChooserComparison | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef<AbortController | null>(null);
    useEffect(() => () => pending.current?.abort(), []);
    const run = async () => {
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setError("");
        setResult(null);
        try {
            setResult(
                await api<ChooserComparison>({
                    route: "/control/compare-choosers",
                    body: { jev, split: "held-out" },
                    signal: controller.signal,
                })
            );
        } catch (cause) {
            setError(controller.signal.aborted ? "Comparison stopped." : errorMessage(cause));
        } finally {
            setBusy(false);
            pending.current = null;
        }
    };
    return (
        <Card variant="wow-static" accent="cyan">
            <CardHeader>
                <CardTitle>Exact → Jev → host handoff</CardTitle>
                <p className="text-sm text-muted-foreground">
                    Compare fixed thresholds on five held-out synthetic cases. Auto uses exact binding first and calls
                    Jev only when enabled and needed.
                </p>
            </CardHeader>
            <CardContent className="space-y-5">
                <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={jev}
                            disabled={busy}
                            onChange={(event) => setJev(event.target.checked)}
                        />
                        Include Jev and Auto · paid requests
                    </label>
                    <Button variant="brand" disabled={busy} onClick={() => void run()}>
                        Compare choosers
                    </Button>
                    {busy && (
                        <Button variant="outline" onClick={() => pending.current?.abort()}>
                            Stop
                        </Button>
                    )}
                </div>
                {error && (
                    <div role="alert">
                        <Callout tone="err" title="Comparison stopped">
                            {error}
                        </Callout>
                    </div>
                )}
                {result && (
                    <>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead className="text-muted-foreground">
                                    <tr>
                                        {[
                                            "Chooser",
                                            "Correct",
                                            "Wrong actions",
                                            "Abstentions",
                                            "Requests",
                                            "Elapsed",
                                        ].map((label) => (
                                            <th className="p-3" key={label}>
                                                {label}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {result.summary.map((row) => (
                                        <tr className="border-t border-border" key={row.mode}>
                                            <td className="p-3 font-medium">{row.mode}</td>
                                            <td className="p-3">
                                                {row.correct}/{row.cases}
                                            </td>
                                            <td className="p-3">{row.wrongActions}</td>
                                            <td className="p-3">{row.abstentions}</td>
                                            <td className="p-3">{row.requests}</td>
                                            <td className="p-3">{row.elapsedMs.toFixed(0)} ms</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-xs text-muted-foreground">{result.note}</p>
                        <details>
                            <summary className="cursor-pointer text-sm">Per-case evidence</summary>
                            <JsonView value={result.rows} />
                        </details>
                    </>
                )}
                <Callout tone="info" title="One model boundary">
                    An unresolved choice returns a bounded evidence packet to the current host. It never calls another
                    AI model.
                </Callout>
            </CardContent>
        </Card>
    );
}
