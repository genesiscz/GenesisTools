/** @jsxImportSource @opentui/solid */
import type { Analyzer } from "@app/doctor/lib/analyzer";
import type { EngineEvent, Finding } from "@app/doctor/lib/types";
import { createMemo, For } from "solid-js";
import { AnalyzerPanel } from "./AnalyzerPanel";

interface DashboardProps {
    analyzers: Analyzer[];
    events: EngineEvent[];
    findingsById: Map<string, Finding>;
    focusedAnalyzerId: string;
}

export function Dashboard(props: DashboardProps) {
    const allFindings = createMemo(() => Array.from(props.findingsById.values()));

    return (
        <box flexDirection="row" flexWrap="wrap" gap={1}>
            <For each={props.analyzers}>
                {(analyzer) => (
                    <AnalyzerPanel
                        analyzer={analyzer}
                        events={props.events}
                        findings={allFindings().filter((finding) => finding.analyzerId === analyzer.id)}
                        focused={analyzer.id === props.focusedAnalyzerId}
                    />
                )}
            </For>
        </box>
    );
}
