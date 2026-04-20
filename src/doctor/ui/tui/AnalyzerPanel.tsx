/** @jsxImportSource @opentui/solid */
import type { Analyzer } from "@app/doctor/lib/analyzer";
import { formatBytes } from "@app/doctor/lib/size";
import type { EngineEvent, Finding } from "@app/doctor/lib/types";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { THEME } from "./theme";

interface AnalyzerPanelProps {
    analyzer: Analyzer;
    events: EngineEvent[];
    findings: Finding[];
    focused: boolean;
}

type PanelStatus = "pending" | "running" | "done" | "error";

interface PanelState {
    status: PanelStatus;
    percent: number;
    currentItem: string | null;
    startedAtMs: number | null;
    doneDurationMs: number | null;
}

function deriveState(events: EngineEvent[], analyzerId: string): PanelState {
    let status: PanelStatus = "pending";
    let percent = 0;
    let currentItem: string | null = null;
    let startedAtMs: number | null = null;
    let doneDurationMs: number | null = null;

    for (const event of events) {
        if (!("analyzerId" in event) || event.analyzerId !== analyzerId) {
            continue;
        }

        if (event.type === "analyzer-start") {
            status = "running";
            startedAtMs = Date.parse(event.startedAt);
            continue;
        }

        if (event.type === "progress") {
            status = "running";
            percent = event.percent ?? percent;
            currentItem = event.currentItem ?? currentItem;
            continue;
        }

        if (event.type === "analyzer-done") {
            status = event.error ? "error" : "done";
            percent = 100;
            doneDurationMs = event.durationMs;
        }
    }

    return { status, percent, currentItem, startedAtMs, doneDurationMs };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function progressBar(percent: number, width: number): string {
    const filled = Math.floor((percent / 100) * width);
    return `${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
}

function formatDurationMs(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }

    return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(value: string, max: number): string {
    if (value.length <= max) {
        return value;
    }

    return `${value.slice(0, max - 1)}…`;
}

export function AnalyzerPanel(props: AnalyzerPanelProps) {
    const state = createMemo(() => deriveState(props.events, props.analyzer.id));

    const [tick, setTick] = createSignal(0);
    const interval = setInterval(() => setTick((current) => current + 1), 100);
    onCleanup(() => clearInterval(interval));

    const spinnerFrame = createMemo(() => SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]);

    const elapsedMs = createMemo(() => {
        const current = state();

        if (current.status === "done" || current.status === "error") {
            return current.doneDurationMs ?? 0;
        }

        if (current.startedAtMs === null) {
            return 0;
        }

        // Depend on tick() so the elapsed counter ticks every 100ms.
        void tick();
        return Date.now() - current.startedAtMs;
    });

    const reclaimableBytes = createMemo(() =>
        props.findings.reduce((total, finding) => total + (finding.reclaimableBytes ?? 0), 0)
    );

    const statusLine = createMemo(() => {
        const current = state();

        if (current.status === "pending") {
            return "waiting…";
        }

        if (current.status === "error") {
            return "error";
        }

        if (current.status === "done") {
            return "done";
        }

        return current.currentItem ? truncate(current.currentItem, 22) : "scanning…";
    });

    const statusColor = createMemo(() => {
        const current = state().status;

        if (current === "done") {
            return THEME.success;
        }

        if (current === "error") {
            return THEME.danger;
        }

        if (current === "running") {
            return THEME.accent;
        }

        return THEME.fgDim;
    });

    const barColor = createMemo(() => {
        const current = state().status;

        if (current === "done") {
            return THEME.success;
        }

        if (current === "error") {
            return THEME.danger;
        }

        return THEME.accent;
    });

    const indicator = createMemo(() => {
        const current = state().status;

        if (current === "running") {
            return spinnerFrame();
        }

        if (current === "done") {
            return "✓";
        }

        if (current === "error") {
            return "✗";
        }

        return "·";
    });

    return (
        <box
            border
            borderStyle={props.focused ? "rounded" : "single"}
            borderColor={props.focused ? THEME.accent : THEME.muted}
            padding={1}
            width={26}
            height={9}
            flexDirection="column"
        >
            <text fg={props.focused ? THEME.accent : THEME.fg}>
                <span>{`${props.analyzer.icon}  ${props.analyzer.name}  `}</span>
                <span fg={statusColor()}>{indicator()}</span>
            </text>
            <text>
                <span fg={barColor()}>{progressBar(state().percent, 14)}</span>
                <span fg={THEME.fgDim}>{` ${state().percent.toFixed(0)}%`}</span>
            </text>
            <text fg={statusColor()}>{statusLine()}</text>
            <text fg={THEME.fgDim}>
                <span>{`${props.findings.length} findings`}</span>
                <Show when={elapsedMs() > 0}>
                    <span>{`  ·  ${formatDurationMs(elapsedMs())}`}</span>
                </Show>
            </text>
            <text fg={THEME.fgDim}>
                <Show when={reclaimableBytes() > 0} fallback={<span> </span>}>
                    <span>{formatBytes(reclaimableBytes())}</span>
                </Show>
            </text>
        </box>
    );
}
