import type { ReplayCase } from "@app/control/lib/decision/fixtures";
import type { ReplayResult } from "@app/control/lib/decision/replay";
import { Badge, Callout, JsonView } from "@artifact/kit";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { CheckCheck, MousePointer2, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./client";
import { WaitLab } from "./WaitLab";

export function ControlLab() {
    const [fixtures, setFixtures] = useState<ReplayCase[]>([]);
    const [selected, setSelected] = useState("context");
    const [chooser, setChooser] = useState("mock");
    const [results, setResults] = useState<ReplayResult[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const abort = useRef<AbortController | null>(null);
    const fixture = fixtures.find((item) => item.id === selected);
    useEffect(() => {
        const controller = new AbortController();
        void api<ReplayCase[]>({ route: "/control/cases", signal: controller.signal })
            .then(setFixtures)
            .catch((cause) => {
                if (!controller.signal.aborted) {
                    setError(errorMessage(cause));
                }
            });
        return () => {
            controller.abort();
            abort.current?.abort();
        };
    }, []);
    const run = async (compare: boolean) => {
        if (!fixture || busy) {
            return;
        }
        const controller = new AbortController();
        abort.current = controller;
        setBusy(true);
        setError("");
        setResults([]);
        try {
            for (const mode of compare ? ["exact", "mock", "jev"] : [chooser]) {
                controller.signal.throwIfAborted();
                const result = await api<ReplayResult>({
                    route: "/control/replay",
                    body: { fixture, chooser: mode },
                    signal: controller.signal,
                });
                controller.signal.throwIfAborted();
                setResults((previous) => [...previous, result]);
            }
        } catch (cause) {
            setError(controller.signal.aborted ? "Replay stopped." : errorMessage(cause));
        } finally {
            setBusy(false);
            abort.current = null;
        }
    };
    const latest = results.at(-1);
    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <p className="section-label text-primary">Observe · choose · verify</p>
                    <h1 className="text-3xl font-semibold tracking-tight">Control Lab</h1>
                    <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                        Compare target selection and outcome judgments on the same window. Every replay stays inside a
                        retained fixture.
                    </p>
                </div>
                <Badge>Decision only · 0 desktop actions</Badge>
            </div>
            <Card variant="default">
                <CardContent className="flex flex-wrap items-end gap-4 pt-6">
                    <label className="jev-field flex-1">
                        Observation
                        <select
                            aria-label="Control fixture"
                            className="rounded border border-border bg-background p-2"
                            value={selected}
                            disabled={busy}
                            onChange={(event) => {
                                setSelected(event.target.value);
                                setResults([]);
                            }}
                        >
                            {fixtures.map((item) => (
                                <option value={item.id} key={item.id}>
                                    {item.title}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="jev-field">
                        Chooser
                        <select
                            aria-label="Control chooser"
                            className="rounded border border-border bg-background p-2"
                            value={chooser}
                            disabled={busy}
                            onChange={(event) => setChooser(event.target.value)}
                        >
                            <option value="mock">Fixture oracle (free)</option>
                            <option value="exact">Exact label (free)</option>
                            <option value="jev">Jev (paid requests)</option>
                        </select>
                    </label>
                    <Button variant="brand" disabled={busy || !fixture} onClick={() => void run(false)}>
                        <Play size={14} /> Replay
                    </Button>
                    <Button variant="outline" disabled={busy || !fixture} onClick={() => void run(true)}>
                        Compare all three
                    </Button>
                    {busy && (
                        <Button variant="outline" onClick={() => abort.current?.abort()}>
                            <Square size={14} /> Stop
                        </Button>
                    )}
                </CardContent>
            </Card>
            {error && (
                <div role="alert">
                    <Callout tone="err" title="Replay message">
                        {error}
                    </Callout>
                </div>
            )}
            <div className="grid gap-6 lg:grid-cols-2">
                <Card variant="default">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <MousePointer2 size={18} /> Observed window
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm">
                            <strong>Intent:</strong> {fixture?.intent}
                        </p>
                        <p className="text-sm text-muted-foreground">
                            <strong>Expected outcome:</strong> {fixture?.expect}
                        </p>
                        <div className="rounded-lg border border-border bg-background/60 p-4">
                            <div className="mb-3 border-b border-border pb-2 text-xs text-muted-foreground">
                                {fixture?.observation.window.title} · synthetic AX capture
                            </div>
                            {fixture?.observation.elements.map((row) => (
                                <div
                                    key={row.index}
                                    className={`my-2 rounded border p-3 ${latest?.resolution.selected?.element === row.index ? "border-primary bg-primary/10" : "border-border"}`}
                                    style={{
                                        marginLeft: Math.min(row.depth, 4) * 12,
                                        opacity: row.AXEnabled === "0" ? 0.45 : 1,
                                    }}
                                >
                                    <div className="flex justify-between gap-3">
                                        <span className="text-sm font-medium">
                                            {row.AXTitle || row.AXDescription || String(row.AXValue || row.role)}
                                        </span>
                                        <span className="text-xs text-muted-foreground">e{row.index}</span>
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                        {row.role}
                                        {row.AXEnabled === "0" ? " · disabled" : ""}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            These controls illustrate the retained observation. Native actions run through the CLI
                            against a fresh snapshot.
                        </p>
                    </CardContent>
                </Card>
                <Card variant="default">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <CheckCheck size={18} /> Decision and evidence
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {latest ? (
                            <>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="rounded border border-border p-4">
                                        <p className="text-xs text-muted-foreground">Target</p>
                                        <p className="mt-1 text-xl">
                                            {latest.resolution.selected?.label ?? "Abstained"}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {latest.resolution.selected?.ancestors.join(" → ")}
                                        </p>
                                    </div>
                                    <div className="rounded border border-border p-4">
                                        <p className="text-xs text-muted-foreground">Outcome judgment</p>
                                        <p className="mt-1 text-xl">{latest.judgment.status}</p>
                                        <p className="text-xs text-muted-foreground">
                                            Evidence: {latest.judgment.evidence.join(", ") || "insufficient"}
                                        </p>
                                    </div>
                                </div>
                                <p className="text-sm text-muted-foreground">{latest.note}</p>
                                <JsonView
                                    value={{
                                        decision: latest.resolution.decision,
                                        probabilities: latest.judgment.probabilities,
                                        candidates: latest.resolution.candidates,
                                    }}
                                />
                            </>
                        ) : (
                            <div className="jev-empty">
                                <MousePointer2 size={32} />
                                <h2>Inspect a bounded decision</h2>
                                <p>Start with the free fixture oracle, then compare Jev on the same evidence.</p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
            {results.length > 0 && (
                <Card variant="default">
                    <CardHeader>
                        <CardTitle className="text-base">Comparison</CardTitle>
                    </CardHeader>
                    <CardContent className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="text-xs text-muted-foreground">
                                <tr>
                                    {[
                                        "Chooser",
                                        "Target",
                                        "Outcome",
                                        "Abstained",
                                        "Decision / verify",
                                        "Requests",
                                        "Tokens",
                                        "Cost USD",
                                    ].map((label) => (
                                        <th className="p-2" key={label}>
                                            {label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {results.map((result) => (
                                    <tr className="border-t border-border" key={result.chooser}>
                                        <td className="p-2">{result.chooser}</td>
                                        <td className="p-2">
                                            {result.metrics.correctTarget
                                                ? "Correct"
                                                : result.metrics.wrongTarget
                                                  ? "Wrong target"
                                                  : "Missed target"}
                                        </td>
                                        <td className="p-2">
                                            {result.metrics.correctOutcome ? "Correct" : "Mismatch"}
                                        </td>
                                        <td className="p-2">{result.metrics.abstained ? "Yes" : "No"}</td>
                                        <td className="p-2">
                                            {result.metrics.decisionMs.toFixed(0)} /{" "}
                                            {result.metrics.verificationMs.toFixed(0)} ms
                                        </td>
                                        <td className="p-2">{result.metrics.requests}</td>
                                        <td className="p-2">
                                            {result.metrics.inputTokens ?? "?"} in /{" "}
                                            {result.metrics.outputTokens ?? "?"} out
                                        </td>
                                        <td className="p-2">
                                            {result.metrics.costUsd === null
                                                ? "Not reported"
                                                : result.metrics.costUsd.toFixed(6)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </CardContent>
                </Card>
            )}
            <WaitLab />
            <Callout tone="info" title="Use the same core from your terminal">
                <code>tools control replay context --chooser jev --provider typesafe</code>
                <p className="mt-2">
                    Live commands: resolve, judge, fill, assist, await and sequence. The model chooses among observed
                    actions; native validation admits each action and exact readback remains authoritative.
                </p>
            </Callout>
        </div>
    );
}
