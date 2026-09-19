import type { ObserveFanout } from "@app/control/lib/decision/observe";
import { Callout, JsonView } from "@artifact/kit";
import type { CompactResult } from "@genesiscz/utils/ai/compact";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Activity, Compass, Eye, Gauge, ScanLine, Scissors } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ListenLabStatus, ListenLabTail } from "../lib/listen/lab";
import type { RouteDecision } from "../lib/route/router";
import type { VerifyResult } from "../lib/screen/verify";
import type { WatchResult } from "../lib/watch/loop";
import { api, errorMessage } from "./client";

type Tone = "ok" | "warn" | "err" | "info" | "neutral";

/**
 * The artifact kit's `tone` palette (`--ok`, `--warn`) is not part of this dashboard's theme, so a
 * toned kit badge renders colourless here. These are the shared shadcn variants from
 * `docs/design-system.md`, which resolve against the theme tokens.
 */
const TONE_VARIANT: Record<Tone, "default" | "secondary" | "destructive" | "cyber" | "outline"> = {
    ok: "default",
    warn: "secondary",
    err: "destructive",
    info: "cyber",
    neutral: "outline",
};

function Chip({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
    return (
        <Badge variant={TONE_VARIANT[tone]} className="font-mono">
            {children}
        </Badge>
    );
}

const STATUS_CLASS: Record<string, string> = {
    act: "text-primary",
    would: "text-primary",
    wake: "text-primary",
    hold: "text-destructive",
    abstain: "text-muted-foreground",
    stop: "text-muted-foreground",
};

const IDLE: ListenLabStatus = { running: false, dryRun: true, events: 0, tail: [] };

interface FixtureList {
    fixtures: Array<{ id: string; title: string; events: number }>;
    cases: Array<{ id: string; title: string }>;
}

/** One request lifecycle: busy flag, abortable run, last result, last error. Shared by every card. */
function useJevCall<T>() {
    const [result, setResult] = useState<T | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef<AbortController | null>(null);
    useEffect(() => () => pending.current?.abort(), []);
    const run = useCallback(async (route: string, body: unknown) => {
        const controller = new AbortController();
        pending.current?.abort();
        pending.current = controller;
        setBusy(true);
        setError("");
        try {
            const next = await api<T>({ route, body, signal: controller.signal });
            if (!controller.signal.aborted) {
                setResult(next);
            }
        } catch (cause) {
            setError(controller.signal.aborted ? "Cancelled." : errorMessage(cause));
        } finally {
            setBusy(false);
            pending.current = null;
        }
    }, []);
    return { result, error, busy, run };
}

const INPUT_CLASS = "rounded border border-border bg-background p-2 font-mono text-sm text-foreground";

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="jev-field min-w-[12rem] flex-1">
            {label}
            {children}
        </label>
    );
}

function Metric({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="rounded border border-border/60 bg-muted/30 px-3 py-2">
            <p className="section-label text-muted-foreground">{label}</p>
            <p className="font-mono text-sm text-foreground">{value}</p>
        </div>
    );
}

function CardShell({
    title,
    icon,
    accent,
    lead,
    children,
}: {
    title: string;
    icon: ReactNode;
    accent: "cyan" | "emerald" | "violet" | "amber";
    lead: string;
    children: ReactNode;
}) {
    return (
        <Card variant="wow-static" accent={accent}>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    {icon}
                    {title}
                </CardTitle>
                <p className="text-sm text-muted-foreground">{lead}</p>
            </CardHeader>
            <CardContent className="space-y-4">{children}</CardContent>
        </Card>
    );
}

function TailRow({ row }: { row: ListenLabTail }) {
    return (
        <li className="grid grid-cols-[4.5rem_1fr_7rem_3rem] items-baseline gap-2 border-b border-border/40 py-1.5 last:border-0">
            <span className={`font-mono text-xs uppercase ${STATUS_CLASS[row.status] ?? "text-muted-foreground"}`}>
                {row.status}
            </span>
            <span className="truncate font-mono text-sm text-foreground" title={row.command ?? row.transcript}>
                {row.command ?? row.transcript}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground" title={row.reason}>
                {row.choice ?? row.reason}
            </span>
            <span className="text-right font-mono text-xs text-muted-foreground">{row.probability.toFixed(2)}</span>
        </li>
    );
}

function ListenStrip({ fixtures }: { fixtures: FixtureList["fixtures"] }) {
    const [status, setStatus] = useState<ListenLabStatus>(IDLE);
    const [fixture, setFixture] = useState("calculator-press-seven");
    const [app, setApp] = useState("");
    const [goal, setGoal] = useState("");
    const [error, setError] = useState("");
    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            const next = await api<ListenLabStatus>({ route: "/listen/status", ...(signal ? { signal } : {}) });
            setStatus(next);
        } catch (cause) {
            if (!signal?.aborted) {
                setError(errorMessage(cause));
            }
        }
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);
    useEffect(() => {
        if (!status.running) {
            return;
        }

        // The session runs server-side; 700 ms is a readable tail without hammering the middleware.
        const timer = setInterval(() => void load(), 700);
        return () => clearInterval(timer);
    }, [status.running, load]);
    const call = async (route: string, body: unknown) => {
        try {
            setStatus(await api<ListenLabStatus>({ route, body }));
            setError("");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const start = () =>
        call("/listen/start", {
            fixture,
            ...(app.trim() ? { app: app.trim() } : {}),
            ...(goal.trim() ? { goal: goal.trim() } : {}),
        });
    return (
        <Card variant="wow" accent="cyan">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Activity className="size-4 text-primary" />
                    Listen
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                    The real listen pipeline over a server-side transcript. The browser never opens a microphone, and
                    this door never dispatches: every decision it makes is dry-run.
                </p>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                    <Field label="Transcript fixture">
                        <select
                            aria-label="Listen fixture"
                            className={INPUT_CLASS}
                            value={fixture}
                            disabled={status.running}
                            onChange={(event) => setFixture(event.target.value)}
                        >
                            {fixtures.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.title} ({item.events} events)
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Standing goal (optional)">
                        <input
                            className={INPUT_CLASS}
                            value={goal}
                            disabled={status.running}
                            placeholder="otherwise the transcript is the intent"
                            onChange={(event) => setGoal(event.target.value)}
                        />
                    </Field>
                    <Field label="Native app (optional, observes only)">
                        <input
                            className={INPUT_CLASS}
                            value={app}
                            disabled={status.running}
                            placeholder="empty = the retained fixture window"
                            onChange={(event) => setApp(event.target.value)}
                        />
                    </Field>
                    <Button variant="brand" disabled={status.running} onClick={() => void start()}>
                        Start session
                    </Button>
                    <Button variant="outline" disabled={!status.running} onClick={() => void call("/listen/stop", {})}>
                        Stop
                    </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Chip tone={status.running ? "ok" : "neutral"}>{status.running ? "running" : "idle"}</Chip>
                    <Chip tone="info">{status.dryRun ? "dry-run" : "act"}</Chip>
                    <Chip>{status.transcript ?? "no session"}</Chip>
                    <Chip>{status.app ?? "fixture window"}</Chip>
                    <Chip tone={status.wouldPress ? "ok" : "neutral"}>
                        would press: {status.wouldPress ?? "nothing"}
                    </Chip>
                </div>
                {status.tail.length > 0 ? (
                    <ol className="rounded border border-border/60 bg-muted/20 px-3 py-1">
                        {status.tail.map((row) => (
                            <TailRow key={row.index} row={row} />
                        ))}
                    </ol>
                ) : (
                    <p className="rounded border border-dashed border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
                        No decisions yet. Start a session to watch the transcript, the admitted choice and its
                        probability arrive one event at a time.
                    </p>
                )}
                {status.error && (
                    <Callout tone="warn" title="Session">
                        {status.error}
                    </Callout>
                )}
                {error && (
                    <Callout tone="warn" title="Listen">
                        {error}
                    </Callout>
                )}
            </CardContent>
        </Card>
    );
}

function RouteCard() {
    const [utterance, setUtterance] = useState("read the review threads of pull request 409");
    const { result, error, busy, run } = useJevCall<RouteDecision>();
    return (
        <CardShell
            title="Route"
            icon={<Compass className="size-4 text-primary" />}
            accent="violet"
            lead="An utterance becomes one argv. This door decides and prints; it can never execute."
        >
            <div className="flex flex-wrap items-end gap-3">
                <Field label="Utterance">
                    <input
                        className={INPUT_CLASS}
                        value={utterance}
                        disabled={busy}
                        onChange={(event) => setUtterance(event.target.value)}
                    />
                </Field>
                <Button variant="cyber" disabled={busy} onClick={() => void run("/route", { utterance })}>
                    {busy ? "Routing…" : "Route utterance"}
                </Button>
            </div>
            {error && (
                <Callout tone="warn" title="Route">
                    {error}
                </Callout>
            )}
            {result && (
                <div className="space-y-3">
                    <p className="rounded border border-border/60 bg-muted/30 p-3 font-mono text-sm text-foreground">
                        {result.printed || "— nothing admitted —"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Chip tone={result.status === "admitted" ? "ok" : "neutral"}>{result.status}</Chip>
                        <Chip tone="info">p={result.p.toFixed(2)}</Chip>
                        {result.destructive && <Chip tone="err">destructive</Chip>}
                        {result.confirm && <Chip tone="warn">needs confirm</Chip>}
                        <Chip>{result.requests} jev requests</Chip>
                        <Chip>{result.reason}</Chip>
                    </div>
                    {result.bindings.length > 0 && (
                        <ul className="space-y-1">
                            {result.bindings.map((binding) => (
                                <li key={`${binding.kind}-${binding.name}`} className="font-mono text-xs">
                                    <span className="text-primary">{binding.token ?? binding.name}</span>
                                    <span className="text-muted-foreground"> = {binding.value ?? "yes"}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {result.unbound.length > 0 && (
                        <p className="font-mono text-xs text-destructive">unbound: {result.unbound.join(", ")}</p>
                    )}
                </div>
            )}
        </CardShell>
    );
}

const COMPACT_SAMPLE = [
    '{"role":"user","content":"list the files"}',
    `{"role":"assistant","content":"running ls","toolCalls":[{"id":"c1","name":"bash","input":"ls","result":"${"row-".repeat(80)}"}]}`,
    '{"role":"assistant","content":"file7 is largest"}',
    '{"role":"user","content":"thanks"}',
].join("\n");

function CompactCard() {
    const [text, setText] = useState(COMPACT_SAMPLE);
    const { result, error, busy, run } = useJevCall<CompactResult & { table: string[] }>();
    return (
        <CardShell
            title="Compact"
            icon={<Scissors className="size-4 text-primary" />}
            accent="emerald"
            lead="Structural compaction of a session document: keep, drop or truncate, with the reason for each."
        >
            <Field label="Session JSONL">
                <textarea
                    aria-label="Session JSONL"
                    className={`${INPUT_CLASS} h-32 resize-y`}
                    value={text}
                    disabled={busy}
                    onChange={(event) => setText(event.target.value)}
                />
            </Field>
            <Button variant="cyber" disabled={busy} onClick={() => void run("/compact", { text })}>
                {busy ? "Compacting…" : "Compact session"}
            </Button>
            {error && (
                <Callout tone="warn" title="Compact">
                    {error}
                </Callout>
            )}
            {result && (
                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <Metric label="Format" value={result.format} />
                        <Metric label="Source bytes" value={result.counts.sourceBytes} />
                        <Metric label="Reduction" value={`${Math.round(result.stats.reduction * 100)}%`} />
                        <Metric label="Decisions" value={result.decisions.length} />
                    </div>
                    <pre className="overflow-x-auto rounded border border-border/60 bg-muted/30 p-3 font-mono text-xs text-foreground">
                        {result.table.join("\n")}
                    </pre>
                </div>
            )}
        </CardShell>
    );
}

function VerifyCard() {
    const [claims, setClaims] = useState("The release notes name version 4.2.\nThe notes mention a Windows build.");
    const [against, setAgainst] = useState("Release 4.2 ships the new scheduler. Linux and macOS builds are attached.");
    const { result, error, busy, run } = useJevCall<VerifyResult>();
    return (
        <CardShell
            title="Verify"
            icon={<ScanLine className="size-4 text-primary" />}
            accent="amber"
            lead="One Jev request scores every claim against the text and applies the selected document templates."
        >
            <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Claims (one per line)">
                    <textarea
                        aria-label="Claims"
                        className={`${INPUT_CLASS} h-24 resize-y`}
                        value={claims}
                        disabled={busy}
                        onChange={(event) => setClaims(event.target.value)}
                    />
                </Field>
                <Field label="Text to check against">
                    <textarea
                        aria-label="Text to check against"
                        className={`${INPUT_CLASS} h-24 resize-y`}
                        value={against}
                        disabled={busy}
                        onChange={(event) => setAgainst(event.target.value)}
                    />
                </Field>
            </div>
            <Button
                variant="cyber"
                disabled={busy}
                onClick={() => void run("/verify", { claims, against, purposes: ["accuracy"] })}
            >
                {busy ? "Scoring…" : "Score claims"}
            </Button>
            {error && (
                <Callout tone="warn" title="Verify">
                    {error}
                </Callout>
            )}
            {result && (
                <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                        <Chip tone={result.gate.block ? "err" : "ok"}>
                            gate {result.gate.block ? "blocks" : "passes"}
                        </Chip>
                        <Chip>{result.purposes.join(", ") || "no purpose"}</Chip>
                    </div>
                    <ul className="space-y-1">
                        {result.claims.map((claim) => (
                            <li key={claim.id} className="flex items-baseline gap-2 text-sm">
                                <Chip tone={(claim.supported ?? 0) >= 0.8 ? "ok" : "warn"}>
                                    {(claim.supported ?? 0).toFixed(2)}
                                </Chip>
                                <span className="truncate text-foreground">{claim.text}</span>
                            </li>
                        ))}
                    </ul>
                    {result.missingAnswers.length > 0 && (
                        <Callout tone="warn" title="Missing answers">
                            {result.missingAnswers.join(", ")}
                        </Callout>
                    )}
                </div>
            )}
        </CardShell>
    );
}

function ObserveCard({ cases }: { cases: FixtureList["cases"] }) {
    const [caseId, setCaseId] = useState("");
    const [goal, setGoal] = useState("Press the seven key.");
    const { result, error, busy, run } = useJevCall<ObserveFanout>();
    return (
        <CardShell
            title="Observe"
            icon={<Eye className="size-4 text-primary" />}
            accent="violet"
            lead="One fan-out: target, verb, done, blocked, wait and risk in a single request over a retained observation."
        >
            <div className="flex flex-wrap items-end gap-3">
                <Field label="Observation">
                    <select
                        aria-label="Observe fixture"
                        className={INPUT_CLASS}
                        value={caseId}
                        disabled={busy}
                        onChange={(event) => setCaseId(event.target.value)}
                    >
                        <option value="">Fixture calculator window</option>
                        {cases.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.title}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Goal">
                    <input
                        className={INPUT_CLASS}
                        value={goal}
                        disabled={busy}
                        onChange={(event) => setGoal(event.target.value)}
                    />
                </Field>
                <Button
                    variant="cyber"
                    disabled={busy}
                    onClick={() => void run("/observe", { goal, ...(caseId ? { caseId } : {}) })}
                >
                    {busy ? "Observing…" : "Fan out once"}
                </Button>
            </div>
            {error && (
                <Callout tone="warn" title="Observe">
                    {error}
                </Callout>
            )}
            {result && (
                <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                        <Chip tone={result.status === "act" || result.status === "verified" ? "ok" : "warn"}>
                            {result.status}
                        </Chip>
                        <Chip tone="info">{result.verb}</Chip>
                        <Chip>{result.target ? result.target.label : "no target"}</Chip>
                        <Chip>{result.reason}</Chip>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <Metric label="done" value={result.done?.toFixed(2) ?? "—"} />
                        <Metric label="blocked" value={result.blocked?.toFixed(2) ?? "—"} />
                        <Metric label="wait" value={result.wait?.toFixed(2) ?? "—"} />
                        <Metric label="risk" value={result.risk?.toFixed(2) ?? "—"} />
                    </div>
                </div>
            )}
        </CardShell>
    );
}

function WatchCard({ cases }: { cases: FixtureList["cases"] }) {
    const [caseId, setCaseId] = useState("");
    const [goal, setGoal] = useState("The calculator shows seven.");
    const [hz, setHz] = useState(4);
    const { result, error, busy, run } = useJevCall<WatchResult>();
    return (
        <CardShell
            title="Watch"
            icon={<Gauge className="size-4 text-primary" />}
            accent="emerald"
            lead="A bounded watch loop on the same retained observation: ticks, observes and the refusal that ended it."
        >
            <div className="flex flex-wrap items-end gap-3">
                <Field label="Observation">
                    <select
                        aria-label="Watch fixture"
                        className={INPUT_CLASS}
                        value={caseId}
                        disabled={busy}
                        onChange={(event) => setCaseId(event.target.value)}
                    >
                        <option value="">Fixture calculator window</option>
                        {cases.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.title}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Goal">
                    <input
                        className={INPUT_CLASS}
                        value={goal}
                        disabled={busy}
                        onChange={(event) => setGoal(event.target.value)}
                    />
                </Field>
                <Field label="Hz">
                    <input
                        type="number"
                        min={1}
                        max={10}
                        className={INPUT_CLASS}
                        value={hz}
                        disabled={busy}
                        onChange={(event) => setHz(Number(event.target.value) || 1)}
                    />
                </Field>
                <Button
                    variant="cyber"
                    disabled={busy}
                    onClick={() => void run("/watch", { goal, hz, seconds: 2, ...(caseId ? { caseId } : {}) })}
                >
                    {busy ? "Watching…" : "Watch 2 seconds"}
                </Button>
            </div>
            {error && (
                <Callout tone="warn" title="Watch">
                    {error}
                </Callout>
            )}
            {result && (
                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <Metric label="Status" value={result.status} />
                        <Metric label="Ticks" value={result.ticks} />
                        <Metric label="Observes" value={result.observes} />
                        <Metric label="Hz" value={result.hz} />
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                        {result.reason}
                        {result.lastRefusal ? ` · last refusal: ${result.lastRefusal}` : ""}
                    </p>
                    {result.lastState && (
                        <details>
                            <summary className="cursor-pointer text-sm text-muted-foreground">
                                View the last encoded state
                            </summary>
                            <JsonView value={result.lastState} />
                        </details>
                    )}
                </div>
            )}
        </CardShell>
    );
}

export function LivePolicyLab() {
    const [fixtures, setFixtures] = useState<FixtureList>({ fixtures: [], cases: [] });
    const [error, setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        void api<FixtureList>({ route: "/listen/fixtures", signal: controller.signal })
            .then(setFixtures)
            .catch((cause) => {
                if (!controller.signal.aborted) {
                    setError(errorMessage(cause));
                }
            });
        return () => controller.abort();
    }, []);
    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <p className="section-label text-primary">Listen · route · compact · verify · observe · watch</p>
                    <h1 className="text-3xl font-semibold tracking-tight">Live policy</h1>
                    <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                        Every card calls the same library function the CLI calls. Nothing here types, clicks or
                        dispatches: the HTTP door is read-only by construction.
                    </p>
                </div>
                <Chip tone="info">Decision only · 0 desktop actions</Chip>
            </div>
            {error && (
                <Callout tone="warn" title="Fixtures">
                    {error}
                </Callout>
            )}
            <ListenStrip fixtures={fixtures.fixtures} />
            <div className="grid gap-6 xl:grid-cols-2">
                <RouteCard />
                <CompactCard />
                <ObserveCard cases={fixtures.cases} />
                <WatchCard cases={fixtures.cases} />
            </div>
            <VerifyCard />
        </div>
    );
}
