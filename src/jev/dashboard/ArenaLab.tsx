import { Badge, Callout, Meter } from "@artifact/kit";
import { SafeJSON } from "@genesiscz/utils/json";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Download, Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
    CIRCUIT_REVISION,
    CIRCUIT_SOURCE,
    CIRCUIT_TIERS,
    type CircuitGraph,
    type CircuitStatus,
    type CircuitTierId,
} from "../lib/arena/circuit";
import { FlyArena } from "../lib/arena/engine";
import {
    ARENA_DURATION,
    ARENA_HEIGHT,
    ARENA_TARGET,
    ARENA_WIDTH,
    type ArenaDecision,
    type ArenaMode,
    type ArenaObservation,
    type ArenaSnapshot,
    needsCircuit,
    needsJev,
    type Wiring,
} from "../lib/arena/types";
import type { ArenaWorkerInput, ArenaWorkerOutput } from "./arena.worker";
import { arenaPalette, drawArena, drawCircuit } from "./arena-renderer";
import { api, download, errorMessage } from "./client";

const MODES: Array<{ id: ArenaMode; label: string; description: string }> = [
    {
        id: "human",
        label: "You",
        description: "Steer with WASD or arrows. Hold Space to dash. No model calls or downloads.",
    },
    {
        id: "malecns",
        label: "MaleCNS reflex",
        description: "A foraging baseline seeks sugar; simulated LC16 → MDN activity drives escape bursts.",
    },
    {
        id: "jev",
        label: "Jev policy",
        description: "Jev chooses a game action from sensory summaries. No connectome download.",
    },
    {
        id: "hybrid",
        label: "Jev + MaleCNS",
        description:
            "Jev sees neural activity and chooses actions; the local MaleCNS reflex can override it to escape.",
    },
];
interface DecisionLog extends ArenaDecision {
    elapsed: number;
    applied: boolean;
}
interface Round {
    mode: ArenaMode;
    wiring: Wiring;
    seed: number;
    sugar: number;
    dodges: number;
    seconds: number;
    outcome: string;
    requests: number;
}
const blank = (seed: number) => new FlyArena({ mode: "human", seed, wiring: "original" }).state;
function Panel({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
    return (
        <Card variant="default">
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
                <CardTitle className="text-sm">{title}</CardTitle>
                {extra}
            </CardHeader>
            <CardContent className="space-y-4">{children}</CardContent>
        </Card>
    );
}

export function ArenaLab() {
    const [mode, setMode] = useState<ArenaMode>("human");
    const [tierId, setTierId] = useState<CircuitTierId>("compact");
    const [wiring, setWiring] = useState<Wiring>("original");
    const [seed, setSeed] = useState(42);
    const [interval, setIntervalSeconds] = useState(2);
    const [view, setView] = useState<ArenaSnapshot>(() => blank(42));
    const [running, setRunning] = useState(false);
    const [loading, setLoading] = useState(false);
    const [thinking, setThinking] = useState(false);
    const [error, setError] = useState("");
    const [loadNote, setLoadNote] = useState("No circuit downloaded. Start a MaleCNS mode to load one.");
    const [catalog, setCatalog] = useState<CircuitStatus[]>(CIRCUIT_TIERS.map((tier) => ({ ...tier, cached: false })));
    const [decisions, setDecisions] = useState<DecisionLog[]>([]);
    const [requests, setRequests] = useState(0);
    const [rounds, setRounds] = useState<Round[]>([]);
    const canvas = useRef<HTMLCanvasElement>(null);
    const brainCanvas = useRef<HTMLCanvasElement>(null);
    const worker = useRef<Worker | null>(null);
    const graph = useRef<{ tier: CircuitTierId; data: CircuitGraph } | null>(null);
    const snapshot = useRef(view);
    const observation = useRef<ArenaObservation | null>(null);
    const keys = useRef(new Set<string>());
    const tickPending = useRef(false);
    const loadController = useRef<AbortController | null>(null);
    const policyController = useRef<AbortController | null>(null);
    const runtime = useRef({
        epoch: 0,
        active: false,
        requests: 0,
        lastDecision: -100,
        lastView: 0,
        recorded: false,
        mode,
        wiring,
        seed,
    });
    const tier = catalog.find((entry) => entry.id === tierId) ?? catalog[0];
    const selected = MODES.find((entry) => entry.id === mode) ?? MODES[0];
    const latest = decisions.at(-1);
    const neural = view.neural;
    const post = (message: ArenaWorkerInput) => worker.current?.postMessage(message);
    const refreshCatalog = async () => {
        try {
            setCatalog(await api<CircuitStatus[]>({ route: "/arena/circuits" }));
        } catch (failure) {
            setError(errorMessage(failure));
        }
    };
    const paint = () => {
        if (!canvas.current || !brainCanvas.current) {
            return;
        }
        const palette = arenaPalette(canvas.current);
        drawArena(canvas.current, snapshot.current, palette);
        drawCircuit(
            brainCanvas.current,
            snapshot.current.neural && needsCircuit(runtime.current.mode) ? (graph.current?.data ?? null) : null,
            snapshot.current,
            palette
        );
    };
    const pause = () => {
        runtime.current.active = false;
        policyController.current?.abort();
        loadController.current?.abort();
        keys.current.clear();
        post({ type: "pause" });
        setRunning(false);
        setThinking(false);
    };
    const reset = (nextSeed: number) => {
        pause();
        runtime.current.epoch++;
        runtime.current.requests = 0;
        runtime.current.lastDecision = -100;
        runtime.current.recorded = false;
        worker.current?.terminate();
        worker.current = null;
        tickPending.current = false;
        snapshot.current = blank(nextSeed);
        observation.current = null;
        setView(snapshot.current);
        setDecisions([]);
        setRequests(0);
        setLoading(false);
        setError("");
    };

    const askPolicy = async () => {
        const current = runtime.current;
        if (
            !current.active ||
            !needsJev(current.mode) ||
            !observation.current ||
            policyController.current ||
            current.requests >= 30
        ) {
            return;
        }
        const controller = new AbortController();
        policyController.current = controller;
        const epoch = current.epoch;
        const state = observation.current;
        current.lastDecision = state.elapsed;
        current.requests++;
        setRequests(current.requests);
        setThinking(true);
        try {
            const result = await api<ArenaDecision>({ route: "/arena/decide", body: state, signal: controller.signal });
            if (epoch !== runtime.current.epoch || controller.signal.aborted) {
                return;
            }
            const applied = runtime.current.active && snapshot.current.elapsed - state.elapsed < 4;
            setDecisions((previous) => [...previous, { ...result, elapsed: state.elapsed, applied }].slice(-30));
            if (applied) {
                post({ type: "decision", decision: result });
            }
        } catch (failure) {
            if (!controller.signal.aborted && epoch === runtime.current.epoch) {
                post({ type: "fallback" });
                setError(`Jev: ${errorMessage(failure)} The foraging/reflex fallback keeps playing.`);
            }
        } finally {
            if (policyController.current === controller) {
                policyController.current = null;
                setThinking(false);
            }
        }
    };

    const initialize = async (action: "start" | "step") => {
        setError("");
        if (worker.current) {
            runtime.current.active = action === "start";
            post({ type: action });
            setRunning(action === "start");
            canvas.current?.focus();
            return;
        }
        const epoch = ++runtime.current.epoch;
        const controller = new AbortController();
        loadController.current = controller;
        setLoading(true);
        try {
            if (needsCircuit(mode) && graph.current?.tier !== tierId) {
                setLoadNote(
                    tier.cached
                        ? "Reading and verifying cached circuit…"
                        : `Downloading ${(tier.bytes / 1e6).toFixed(1)} MB on demand…`
                );
                const loaded = await api<{ graph: CircuitGraph; cacheHit: boolean }>({
                    route: "/arena/circuit",
                    body: { tierId },
                    signal: controller.signal,
                });
                if (epoch !== runtime.current.epoch || controller.signal.aborted) {
                    return;
                }
                graph.current = { tier: tierId, data: loaded.graph };
                setLoadNote(
                    (loaded.cacheHit ? "Verified local cache" : "Downloaded, verified, and cached") +
                        " · " +
                        tier.neurons.toLocaleString() +
                        " neurons"
                );
                void refreshCatalog();
            }
            controller.signal.throwIfAborted();
            runtime.current = {
                epoch,
                active: action === "start",
                requests: 0,
                lastDecision: -100,
                lastView: 0,
                recorded: false,
                mode,
                wiring,
                seed,
            };
            const next = new Worker(new URL("./arena.worker.ts", import.meta.url), { type: "module" });
            worker.current = next;
            next.onmessage = (event: MessageEvent<ArenaWorkerOutput>) => {
                if (epoch !== runtime.current.epoch) {
                    return;
                }
                tickPending.current = false;
                setLoading(false);
                if (event.data.type === "error") {
                    setError(event.data.message);
                    pause();
                    return;
                }
                snapshot.current = event.data.state;
                observation.current = event.data.observation;
                const now = snapshot.current;
                if (now.elapsed - runtime.current.lastView >= 0.1 || now.status !== "running") {
                    runtime.current.lastView = now.elapsed;
                    setView({ ...now });
                }

                if (now.status === "won" || now.status === "lost") {
                    pause();
                    if (!runtime.current.recorded) {
                        runtime.current.recorded = true;
                        setRounds((previous) =>
                            [
                                ...previous,
                                {
                                    mode,
                                    wiring,
                                    seed,
                                    sugar: now.sugar,
                                    dodges: now.dodges,
                                    seconds: now.elapsed,
                                    outcome: now.status,
                                    requests: runtime.current.requests,
                                },
                            ].slice(-12)
                        );
                    }
                } else if (
                    runtime.current.active &&
                    needsJev(mode) &&
                    now.elapsed - runtime.current.lastDecision >= interval
                ) {
                    void askPolicy();
                }
            };
            next.onerror = (event) => {
                setError(`Simulation worker: ${event.message}`);
                setLoading(false);
                pause();
            };
            post({
                type: "init",
                options: {
                    mode,
                    seed,
                    wiring,
                    ...(needsCircuit(mode) && graph.current ? { graph: graph.current.data } : {}),
                },
            });
            post({ type: action });
            setRunning(action === "start");
            canvas.current?.focus();
        } catch (failure) {
            if (epoch === runtime.current.epoch) {
                setError(
                    controller.signal.aborted ? "Circuit loading stopped. Retry when ready." : errorMessage(failure)
                );
                setLoading(false);
            }
        } finally {
            if (loadController.current === controller) {
                loadController.current = null;
            }
        }
    };

    useEffect(() => {
        void refreshCatalog();
        const release = (event: KeyboardEvent) => keys.current.delete(event.code);
        const hidden = () => {
            if (document.hidden) {
                pause();
            }
        };
        window.addEventListener("keyup", release);
        window.addEventListener("blur", pause);
        document.addEventListener("visibilitychange", hidden);
        return () => {
            runtime.current.epoch++;
            runtime.current.active = false;
            loadController.current?.abort();
            policyController.current?.abort();
            worker.current?.terminate();
            window.removeEventListener("keyup", release);
            window.removeEventListener("blur", pause);
            document.removeEventListener("visibilitychange", hidden);
        };
    }, []);
    useEffect(() => {
        paint();
    }, [view]);
    useEffect(() => {
        if (!running) {
            return;
        }
        let frame = 0;
        let last = 0;
        const draw = (now: number) => {
            if (!runtime.current.active) {
                return;
            }

            if (!last) {
                last = now;
            }

            if (!tickPending.current && now - last >= 20) {
                const pressed = keys.current;
                const input = {
                    x:
                        Number(pressed.has("ArrowRight") || pressed.has("KeyD")) -
                        Number(pressed.has("ArrowLeft") || pressed.has("KeyA")),
                    y:
                        Number(pressed.has("ArrowDown") || pressed.has("KeyS")) -
                        Number(pressed.has("ArrowUp") || pressed.has("KeyW")),
                };
                tickPending.current = true;
                post({
                    type: "advance",
                    milliseconds: Math.min(100, Math.floor((now - last) / 20) * 20),
                    input,
                    dash: pressed.has("Space"),
                });
                last = now - ((now - last) % 20);
            }
            paint();
            frame = requestAnimationFrame(draw);
        };
        frame = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(frame);
    }, [running]);

    return (
        <>
            <div className="jev-heading">
                <div>
                    <p className="jev-help mb-2">MALECNS × JEV / LIVE CONTROL EXPERIMENT</p>
                    <h1>Fly arena</h1>
                    <p className="jev-subtitle">
                        Collect 12 sugar drops. Dodge the swatter. Compare your reflexes, a real connectome circuit, and
                        Jev on the same seeded field.
                    </p>
                </div>
                <Badge tone={running ? "ok" : loading ? "warn" : "neutral"}>
                    {loading ? "Loading circuit" : running ? "Live" : view.status}
                </Badge>
            </div>
            <div className="jev-arena-layout">
                <div className="jev-stack">
                    <Card variant="default">
                        <CardContent className="p-3 sm:p-4 space-y-3">
                            <div className="jev-arena-hud">
                                <span>
                                    <strong>{view.sugar}</strong> / {ARENA_TARGET} sugar
                                </span>
                                <span>
                                    <strong>{view.health}</strong> lives
                                </span>
                                <span>
                                    <strong>{Math.max(0, ARENA_DURATION - view.elapsed).toFixed(1)}</strong> s
                                </span>
                                <span>
                                    <strong>{view.dodges}</strong> dodges
                                </span>
                            </div>
                            <canvas
                                ref={canvas}
                                width={ARENA_WIDTH}
                                height={ARENA_HEIGHT}
                                tabIndex={0}
                                className="jev-arena-canvas"
                                aria-label="Playable fly arena. Use arrow keys or WASD to move, Space to dash."
                                onKeyDown={(event) => {
                                    if (
                                        [
                                            "ArrowUp",
                                            "ArrowDown",
                                            "ArrowLeft",
                                            "ArrowRight",
                                            "KeyW",
                                            "KeyA",
                                            "KeyS",
                                            "KeyD",
                                            "Space",
                                        ].includes(event.code)
                                    ) {
                                        event.preventDefault();
                                        keys.current.add(event.code);
                                    }
                                }}
                            >
                                Fly arena: collect sugar and avoid the swatter. Keyboard and on-screen controls are
                                available.
                            </canvas>
                            <div className="jev-actions">
                                {running || loading ? (
                                    <Button variant="nexus" onClick={pause}>
                                        <Pause />
                                        Pause
                                    </Button>
                                ) : (
                                    <Button
                                        variant="nexus"
                                        disabled={view.status === "won" || view.status === "lost"}
                                        onClick={() => void initialize("start")}
                                    >
                                        <Play />
                                        {view.status === "paused" ? "Resume" : "Start round"}
                                    </Button>
                                )}
                                <Button
                                    variant="outline"
                                    disabled={running || loading || view.status === "won" || view.status === "lost"}
                                    onClick={() => void initialize("step")}
                                >
                                    <StepForward />
                                    Step 100 ms
                                </Button>
                                <Button variant="ghost" onClick={() => reset(seed)}>
                                    <RotateCcw />
                                    Reset same seed
                                </Button>
                                <span className="jev-help ml-auto" role="status">
                                    {view.actionSource} · {view.action}
                                </span>
                            </div>
                            {mode === "human" && (
                                <div className="jev-arena-touch" aria-label="Touch controls">
                                    {[
                                        ["ArrowLeft", "←"],
                                        ["ArrowUp", "↑"],
                                        ["ArrowDown", "↓"],
                                        ["ArrowRight", "→"],
                                        ["Space", "Dash"],
                                    ].map(([code, label]) => (
                                        <Button
                                            key={code}
                                            variant="outline"
                                            aria-label={
                                                code === "Space" ? "Dash" : `Move ${code.slice(5).toLowerCase()}`
                                            }
                                            onPointerDown={(event) => {
                                                event.currentTarget.setPointerCapture(event.pointerId);
                                                keys.current.add(code);
                                            }}
                                            onPointerUp={() => keys.current.delete(code)}
                                            onPointerCancel={() => keys.current.delete(code)}
                                            onLostPointerCapture={() => keys.current.delete(code)}
                                        >
                                            {label}
                                        </Button>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                    <Panel title="Controller">
                        <div className="jev-arena-modes">
                            {MODES.map((entry) => (
                                <button
                                    key={entry.id}
                                    type="button"
                                    className="jev-arena-mode"
                                    aria-pressed={mode === entry.id}
                                    disabled={running || loading}
                                    onClick={() => {
                                        reset(seed);
                                        setMode(entry.id);
                                        runtime.current.mode = entry.id;
                                    }}
                                >
                                    <strong>{entry.label}</strong>
                                    <span>{entry.description}</span>
                                </button>
                            ))}
                        </div>
                        <div className="jev-arena-settings">
                            <label className="jev-field" htmlFor="arena-seed">
                                Level seed
                                <Input
                                    id="arena-seed"
                                    type="number"
                                    min={0}
                                    max={999999}
                                    value={seed}
                                    disabled={running || loading}
                                    onChange={(event) => {
                                        const value = Math.max(0, Math.min(999999, Number(event.target.value)));
                                        setSeed(value);
                                        reset(value);
                                    }}
                                />
                            </label>
                            {needsCircuit(mode) && (
                                <>
                                    <label className="jev-field" htmlFor="arena-tier">
                                        MaleCNS subset
                                        <select
                                            className="jev-select"
                                            id="arena-tier"
                                            value={tierId}
                                            disabled={running || loading}
                                            onChange={(event) => {
                                                reset(seed);
                                                setTierId(event.target.value as CircuitTierId);
                                            }}
                                        >
                                            {catalog.map((entry) => (
                                                <option key={entry.id} value={entry.id}>
                                                    {entry.label} · {entry.neurons.toLocaleString()} cells ·{" "}
                                                    {(entry.bytes / 1e6).toFixed(1)} MB{entry.cached ? " · cached" : ""}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="jev-field" htmlFor="arena-wiring">
                                        Wiring control
                                        <select
                                            className="jev-select"
                                            id="arena-wiring"
                                            value={wiring}
                                            disabled={running || loading}
                                            onChange={(event) => {
                                                reset(seed);
                                                setWiring(event.target.value as Wiring);
                                            }}
                                        >
                                            <option value="original">Original connections</option>
                                            <option value="shuffled">Shuffled targets</option>
                                            <option value="disconnected">Disconnected edges</option>
                                        </select>
                                    </label>
                                </>
                            )}
                            {needsJev(mode) && (
                                <label className="jev-field" htmlFor="arena-cadence">
                                    Seconds between Jev decisions
                                    <Input
                                        id="arena-cadence"
                                        type="number"
                                        min={1}
                                        max={10}
                                        value={interval}
                                        disabled={running || loading}
                                        onChange={(event) => {
                                            reset(seed);
                                            setIntervalSeconds(Math.min(10, Math.max(1, Number(event.target.value))));
                                        }}
                                    />
                                </label>
                            )}
                        </div>
                        <p className="jev-help">
                            {selected.description}{" "}
                            {needsJev(mode) &&
                                "Paid requests start only with the round. One in flight, at most 30 per round. Low-confidence, stale, or failed replies fall back to the local controller."}
                        </p>
                        {needsCircuit(mode) && (
                            <p className="jev-help">
                                {loadNote} Files stay in the local Jev cache, outside the repository.
                            </p>
                        )}
                        {error && (
                            <div role="alert">
                                <Callout tone="err">{error}</Callout>
                            </div>
                        )}
                    </Panel>
                    <Panel
                        title="Same-seed comparisons"
                        extra={
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={!decisions.length && !rounds.length}
                                onClick={() =>
                                    download({
                                        filename: "jev-fly-arena.json",
                                        content: SafeJSON.stringify(
                                            {
                                                dataset: graph.current?.data.manifest ?? null,
                                                revision: CIRCUIT_REVISION,
                                                mode,
                                                wiring,
                                                seed,
                                                state: snapshot.current,
                                                decisions,
                                                rounds,
                                            },
                                            null,
                                            2
                                        ),
                                    })
                                }
                            >
                                <Download />
                                Export
                            </Button>
                        }
                    >
                        {rounds.length ? (
                            <div className="jev-trace">
                                <table className="jev-table">
                                    <caption className="sr-only">Completed fly arena rounds</caption>
                                    <thead>
                                        <tr>
                                            <th>Controller</th>
                                            <th>Wiring</th>
                                            <th>Seed</th>
                                            <th>Sugar</th>
                                            <th>Dodges</th>
                                            <th>Result</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rounds.map((round, index) => (
                                            <tr key={String(index)}>
                                                <td>{round.mode}</td>
                                                <td>{needsCircuit(round.mode) ? round.wiring : "—"}</td>
                                                <td>{round.seed}</td>
                                                <td>{round.sugar}</td>
                                                <td>{round.dodges}</td>
                                                <td>
                                                    {round.outcome} · {round.seconds.toFixed(1)}s
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <p className="jev-help">
                                Completed rounds appear here. Keep the seed fixed, switch controller or wiring, and run
                                again. One round is an anecdote, not evidence that biological wiring improves play.
                            </p>
                        )}
                    </Panel>
                </div>
                <div className="jev-stack">
                    <Panel
                        title="Circuit activity"
                        extra={
                            <Badge tone={neural ? "ok" : "neutral"}>
                                {neural ? `${tier.neurons.toLocaleString()} cells` : "Not loaded"}
                            </Badge>
                        }
                    >
                        <canvas
                            ref={brainCanvas}
                            width={340}
                            height={210}
                            className="jev-brain-canvas"
                            aria-label="Sample of anatomical neuron positions colored by actual simulated firing rate"
                        />
                        <p className="jev-help">
                            {neural
                                ? tier.edges.toLocaleString() +
                                  " traced connections simulated. View samples up to 240 cells; positions are somas, not axon shapes."
                                : needsCircuit(mode)
                                  ? "Start a round to load the selected circuit."
                                  : "No connectome data is needed for Human or Jev-only play."}
                        </p>
                        {neural && (
                            <>
                                <div className="jev-arena-rates">
                                    <span>
                                        LC16 left<strong>{neural.sensoryLeftHz.toFixed(1)} Hz</strong>
                                    </span>
                                    <span>
                                        LC16 right<strong>{neural.sensoryRightHz.toFixed(1)} Hz</strong>
                                    </span>
                                    <span>
                                        MDN left<strong>{neural.leftHz.toFixed(1)} Hz</strong>
                                    </span>
                                    <span>
                                        MDN right<strong>{neural.rightHz.toFixed(1)} Hz</strong>
                                    </span>
                                </div>
                                <Meter
                                    label="Retreat output"
                                    value={neural.retreat}
                                    display={`${(neural.retreat * 100).toFixed(1)}%`}
                                    min={0}
                                    max={1}
                                />
                                <p className="jev-help">
                                    {neural.spikes} spikes in the last step · mean {neural.meanHz.toFixed(2)} Hz
                                </p>
                                <details>
                                    <summary className="jev-help cursor-pointer">Most active cells</summary>
                                    <table className="jev-table">
                                        <tbody>
                                            {neural.top.map((cell) => (
                                                <tr key={cell.id}>
                                                    <td>{cell.type}</td>
                                                    <td>{cell.id}</td>
                                                    <td>{cell.hz.toFixed(1)} Hz</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </details>
                            </>
                        )}
                    </Panel>
                    <Panel
                        title="Jev decision"
                        extra={
                            <Badge tone={thinking ? "warn" : "neutral"}>
                                {thinking ? "Evaluating" : `${requests} / 30 calls`}
                            </Badge>
                        }
                    >
                        {latest ? (
                            <>
                                <div className="jev-metric">{latest.action}</div>
                                <p className="jev-help">
                                    {latest.applied
                                        ? latest.fallback
                                            ? "Low confidence → fallback"
                                            : "Applied policy choice"
                                        : "Stale reply ignored"}{" "}
                                    · {latest.latencyMs} ms
                                </p>
                                <Meter
                                    label="Selected choice probability"
                                    value={latest.confidence ?? 0}
                                    display={
                                        latest.confidence === null
                                            ? "not returned"
                                            : `${(latest.confidence * 100).toFixed(1)}%`
                                    }
                                    min={0}
                                    max={1}
                                />
                                <Meter
                                    label="Immediate threat"
                                    value={latest.threatProbability}
                                    display={`${(latest.threatProbability * 100).toFixed(1)}%`}
                                    min={0}
                                    max={1}
                                />
                                <p className="jev-help">Survival score {latest.survivalScore.toFixed(2)} / 4</p>
                                <div className="jev-trace">
                                    <table className="jev-table">
                                        <caption className="sr-only">Recent Jev arena decisions</caption>
                                        <thead>
                                            <tr>
                                                <th>Time</th>
                                                <th>Action</th>
                                                <th>P</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {decisions
                                                .slice(-8)
                                                .reverse()
                                                .map((entry, index) => (
                                                    <tr key={String(index)}>
                                                        <td>{entry.elapsed.toFixed(1)}s</td>
                                                        <td>
                                                            {entry.action}
                                                            {entry.fallback ? " *" : ""}
                                                        </td>
                                                        <td>
                                                            {entry.confidence === null
                                                                ? "not returned"
                                                                : `${(entry.confidence * 100).toFixed(0)}%`}
                                                        </td>
                                                    </tr>
                                                ))}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        ) : (
                            <p className="jev-help">
                                Choose Jev policy or Jev + MaleCNS, then start a round. Jev receives a small sensory
                                summary and named neural rates, never the full connection graph.
                            </p>
                        )}
                    </Panel>
                    <Panel title="What is biological here?">
                        <p className="jev-help">
                            Real MaleCNS v1.0 neuron identities and synaptic contact counts. This arena uses an
                            extracted LC16 → MDN retreat circuit, not all 166,000 neurons.
                        </p>
                        <p className="jev-help">
                            The 1 ms spiking dynamics, transmitter signs, visual input, food steering, and mapping
                            retreat to a flying dodge are modelling choices. There is no learning or claim of an
                            uploaded fly.
                        </p>
                        <p className="jev-help">
                            Shuffled mode permutes connection targets using the same seed. Disconnected mode removes
                            synaptic influence. Both keep the same sensory adapter and game controller.
                        </p>
                        <div className="flex flex-wrap gap-3 text-xs">
                            <a
                                className="text-primary underline"
                                href="https://male-cns.janelia.org/download/"
                                target="_blank"
                                rel="noreferrer"
                            >
                                Official dataset
                            </a>
                            <a
                                className="text-primary underline"
                                href={`${CIRCUIT_SOURCE}/tree/${CIRCUIT_REVISION}/public/data`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Circuit provenance
                            </a>
                            <a
                                className="text-primary underline"
                                href="https://creativecommons.org/licenses/by/4.0/"
                                target="_blank"
                                rel="noreferrer"
                            >
                                CC BY 4.0
                            </a>
                        </div>
                        <p className="jev-help">
                            Data: FlyEM / HHMI Janelia, Cambridge, MRC LMB, Google Research. Circuit extraction:
                            hrook1/Swat. Arena and readout adaptations: GenesisTools. No endorsement implied.
                        </p>
                    </Panel>
                </div>
            </div>
        </>
    );
}
