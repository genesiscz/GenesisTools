import { useEffect, useMemo, useRef, useState } from "react";
import { type BodyContent, renderBody, SegmentedControl, TONE_TEXT, type Tone } from "./primitives";

export type SimValue = string | number | boolean;

export interface SimStep {
    label: string;
    description?: BodyContent;
    /** State keys this step changes (merged over the previous state). */
    patch?: Record<string, SimValue>;
    /** Log lines this step appends. */
    logs?: string[];
    tone?: Tone;
}

export interface SimulatorProps {
    title?: string;
    initial: Record<string, SimValue>;
    steps: SimStep[];
    /** Autoplay interval in ms (default 1400). */
    interval?: number;
}

interface SimFrame {
    state: Record<string, SimValue>;
    changed: Set<string>;
    logs: string[];
}

function computeFrames(initial: Record<string, SimValue>, steps: SimStep[]): SimFrame[] {
    const frames: SimFrame[] = [{ state: initial, changed: new Set(), logs: [] }];

    for (const step of steps) {
        const prev = frames[frames.length - 1];
        const state = { ...prev.state, ...(step.patch ?? {}) };
        const changed = new Set(Object.keys(step.patch ?? {}));
        frames.push({ state, changed, logs: [...prev.logs, ...(step.logs ?? [])] });
    }

    return frames;
}

function formatValue(value: SimValue): string {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }

    return String(value);
}

/**
 * Generic step-through state-machine player: an ordered list of steps, each
 * patching a visible state and appending log lines. Play, step, or jump.
 */
export function Simulator({ title, initial, steps, interval = 1400 }: SimulatorProps) {
    // index 0 = initial state, index N = after step N
    const [index, setIndex] = useState(0);
    const [playing, setPlaying] = useState(false);
    const frames = useMemo(() => computeFrames(initial, steps), [initial, steps]);
    const frame = frames[index];
    const logRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!playing) {
            return;
        }

        if (index >= steps.length) {
            setPlaying(false);

            return;
        }

        const t = setTimeout(() => setIndex((i) => Math.min(i + 1, steps.length)), interval);

        return () => clearTimeout(t);
    }, [playing, index, steps.length, interval]);

    useEffect(() => {
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    }, [frame.logs.length]);

    const btn =
        "rounded-card border border-line px-3 py-1.5 text-sm text-ink transition-colors " +
        "hover:border-accent hover:text-ink active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none";

    return (
        <div className="my-4 rounded-card border border-line bg-panel/40 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
                {title ? <div className="mr-auto font-semibold text-ink">{title}</div> : null}
                <button
                    type="button"
                    className={btn}
                    onClick={() => {
                        setPlaying(false);
                        setIndex(0);
                    }}
                    disabled={index === 0}
                >
                    Reset
                </button>
                <button
                    type="button"
                    className={btn}
                    onClick={() => setIndex((i) => Math.max(0, i - 1))}
                    disabled={index === 0}
                >
                    Back
                </button>
                <button
                    type="button"
                    className={btn}
                    onClick={() => setIndex((i) => Math.min(steps.length, i + 1))}
                    disabled={index >= steps.length}
                >
                    Step
                </button>
                <button
                    type="button"
                    className={btn}
                    onClick={() => setPlaying((p) => !p)}
                    disabled={index >= steps.length && !playing}
                >
                    {playing ? "Pause" : "Play"}
                </button>
                <span className="font-mono text-xs text-dim">
                    {index}/{steps.length}
                </span>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
                <ol className="max-h-[26rem] space-y-1 overflow-y-auto pr-1">
                    {steps.map((step, i) => {
                        const stepNo = i + 1;
                        const isCurrent = stepNo === index;
                        const isDone = stepNo < index;

                        return (
                            <li key={i}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setPlaying(false);
                                        setIndex(stepNo);
                                    }}
                                    className={`w-full rounded-card border px-3 py-2 text-left text-sm transition-colors ${
                                        isCurrent
                                            ? "border-accent bg-accent/10"
                                            : isDone
                                              ? "border-line bg-panel/60 text-dim"
                                              : "border-line/60 text-dim hover:border-line"
                                    }`}
                                >
                                    <span className="mr-2 font-mono text-xs text-dim">{stepNo}</span>
                                    <span className={isCurrent ? TONE_TEXT[step.tone ?? "info"] : ""}>
                                        {step.label}
                                    </span>
                                    {isCurrent && step.description ? (
                                        <div className="mt-1 text-xs text-dim">{renderBody(step.description)}</div>
                                    ) : null}
                                </button>
                            </li>
                        );
                    })}
                </ol>

                <div className="space-y-3">
                    <div className="rounded-card border border-line bg-canvas/70 p-3">
                        <div className="mb-2 font-mono text-[0.7rem] uppercase tracking-wider text-dim">State</div>
                        <dl className="space-y-1 font-mono text-xs">
                            {Object.entries(frame.state).map(([k, v]) => (
                                <div key={k} className="flex justify-between gap-3">
                                    <dt className="text-dim">{k}</dt>
                                    <dd className={frame.changed.has(k) ? "font-semibold text-accent" : "text-ink/90"}>
                                        {formatValue(v)}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                    <div
                        ref={logRef}
                        className="max-h-48 overflow-y-auto rounded-card border border-line bg-canvas/70 p-3"
                    >
                        <div className="mb-2 font-mono text-[0.7rem] uppercase tracking-wider text-dim">Log</div>
                        {frame.logs.length === 0 ? (
                            <div className="font-mono text-xs text-dim/60">(empty)</div>
                        ) : (
                            frame.logs.map((line, i) => (
                                <div key={i} className="font-mono text-xs leading-relaxed text-ink/90">
                                    {line}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export type SimParams = Record<string, number | string | boolean>;

export type SimControl =
    | {
          kind: "range";
          key: string;
          label: string;
          min: number;
          max: number;
          step?: number;
          unit?: string;
      }
    | { kind: "segmented"; key: string; label: string; options: Array<{ value: string; label: string }> }
    | { kind: "toggle"; key: string; label: string };

export interface SimPreset {
    label: string;
    params: SimParams;
    note?: BodyContent;
}

export interface ParametricSimulatorProps {
    title?: string;
    controls: SimControl[];
    initialParams: SimParams;
    /** PURE derivation: params in, a full scenario out (memoized on params). */
    generate: (params: SimParams) => { initial: Record<string, SimValue>; steps: SimStep[] };
    presets?: SimPreset[];
    interval?: number;
}

/**
 * Slider/segment/toggle-driven simulator: the author writes ONE pure
 * `generate(params)` and gets the control panel, presets, playhead, state
 * readout and log for free. Changing any control regenerates the scenario.
 */
export function ParametricSimulator({
    title,
    controls,
    initialParams,
    generate,
    presets,
    interval,
}: ParametricSimulatorProps) {
    const [params, setParams] = useState<SimParams>(initialParams);
    const [activePreset, setActivePreset] = useState<string | null>(null);
    const scenario = useMemo(() => generate(params), [generate, params]);
    const setParam = (key: string, value: number | string | boolean): void => {
        setActivePreset(null);
        setParams((prev) => ({ ...prev, [key]: value }));
    };

    return (
        <div className="my-4">
            <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3">
                {controls.map((control) => {
                    if (control.kind === "segmented") {
                        return (
                            <SegmentedControl
                                key={control.key}
                                label={control.label}
                                options={control.options}
                                value={String(params[control.key])}
                                onChange={(v) => setParam(control.key, v)}
                            />
                        );
                    }

                    if (control.kind === "toggle") {
                        return (
                            <label
                                key={control.key}
                                className="flex cursor-pointer items-center gap-2 text-sm text-ink/90"
                            >
                                <input
                                    type="checkbox"
                                    checked={Boolean(params[control.key])}
                                    onChange={(e) => setParam(control.key, e.target.checked)}
                                    className="accent-(--accent)"
                                />
                                {control.label}
                            </label>
                        );
                    }

                    const value = Number(params[control.key]);

                    return (
                        <label key={control.key} className="flex min-w-52 flex-col gap-1 text-xs text-dim">
                            <span>
                                {control.label}{" "}
                                <span className="font-mono text-ink/90">
                                    {value}
                                    {control.unit ?? ""}
                                </span>
                            </span>
                            <input
                                type="range"
                                min={control.min}
                                max={control.max}
                                step={control.step ?? 1}
                                value={value}
                                onChange={(e) => setParam(control.key, Number(e.target.value))}
                                className="accent-(--accent)"
                            />
                        </label>
                    );
                })}
            </div>
            {presets?.length ? (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-dim">presets:</span>
                    {presets.map((preset) => (
                        <button
                            key={preset.label}
                            type="button"
                            onClick={() => {
                                setParams({ ...initialParams, ...preset.params });
                                setActivePreset(preset.label);
                            }}
                            className={
                                activePreset === preset.label
                                    ? "rounded-card border border-accent bg-accent/15 px-2.5 py-1 text-xs text-accent"
                                    : "rounded-card border border-line px-2.5 py-1 text-xs text-dim transition-colors hover:border-accent hover:text-ink"
                            }
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
            ) : null}
            {activePreset && presets ? (
                <div className="mb-3 text-sm text-dim">
                    {renderBody(presets.find((p) => p.label === activePreset)?.note)}
                </div>
            ) : null}
            <Simulator
                key={SafeKey(params)}
                title={title}
                initial={scenario.initial}
                steps={scenario.steps}
                interval={interval}
            />
        </div>
    );
}

/** Stable key so the inner Simulator resets its playhead when params change. */
function SafeKey(params: SimParams): string {
    return Object.entries(params)
        .map(([k, v]) => `${k}=${String(v)}`)
        .sort()
        .join("|");
}
