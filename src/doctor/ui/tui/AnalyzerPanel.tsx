/** @jsxImportSource @opentui/solid */
import type { Analyzer } from "@app/doctor/lib/analyzer";
import { formatBytes } from "@app/doctor/lib/size";
import type { EngineEvent, Finding } from "@app/doctor/lib/types";
import { createMemo } from "solid-js";
import { THEME } from "./theme";

interface AnalyzerPanelProps {
    analyzer: Analyzer;
    events: EngineEvent[];
    findings: Finding[];
    focused: boolean;
}

function latestProgress(events: EngineEvent[], analyzerId: string): Extract<EngineEvent, { type: "progress" }> | null {
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];

        if (event?.type === "progress" && event.analyzerId === analyzerId) {
            return event;
        }
    }

    return null;
}

function isDone(events: EngineEvent[], analyzerId: string): boolean {
    return events.some((event) => event.type === "analyzer-done" && event.analyzerId === analyzerId);
}

function progressBar(percent: number, width: number): string {
    const filled = Math.floor((percent / 100) * width);
    return `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
}

export function AnalyzerPanel(props: AnalyzerPanelProps) {
    const progress = createMemo(() => latestProgress(props.events, props.analyzer.id));
    const done = createMemo(() => isDone(props.events, props.analyzer.id));
    const percent = createMemo(() => progress()?.percent ?? (done() ? 100 : 0));
    const reclaimableBytes = createMemo(() =>
        props.findings.reduce((total, finding) => total + (finding.reclaimableBytes ?? 0), 0)
    );

    return (
        <box
            border
            borderStyle={props.focused ? "rounded" : "single"}
            borderColor={props.focused ? THEME.accent : THEME.muted}
            padding={1}
            width={26}
            height={8}
            flexDirection="column"
        >
            <text fg={props.focused ? THEME.accent : THEME.fg}>
                {`${props.analyzer.icon}  ${props.analyzer.name}`}
            </text>
            <text>
                <span fg={done() ? THEME.success : THEME.accent}>{progressBar(percent(), 14)}</span>
                <span fg={THEME.fgDim}> {percent().toFixed(0)}%</span>
            </text>
            <text fg={THEME.fg}>{`${props.findings.length} findings`}</text>
            <text fg={THEME.fgDim}>{reclaimableBytes() > 0 ? formatBytes(reclaimableBytes()) : "n/a"}</text>
        </box>
    );
}
