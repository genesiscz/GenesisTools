/** @jsxImportSource @opentui/solid */
import type { EnginePhase } from "./stores/engine-store";
import { THEME } from "./theme";

interface ToolbarProps {
    phase: EnginePhase;
    findingsCount: number;
}

export function Toolbar(props: ToolbarProps) {
    const phaseColor = (): string => {
        if (props.phase === "done") {
            return THEME.success;
        }

        if (props.phase === "scanning") {
            return THEME.accent;
        }

        return THEME.warn;
    };

    return (
        <box border borderStyle="rounded" borderColor={THEME.accent} padding={1} backgroundColor={THEME.bgAlt}>
            <text>
                <span fg={THEME.accent}>
                    <strong>macOS Doctor</strong>
                </span>
                <span fg={THEME.fgDim}> · </span>
                <span fg={phaseColor()}>{props.phase}</span>
                <span fg={THEME.fgDim}> · </span>
                <span fg={THEME.fg}>
                    {props.findingsCount} {props.findingsCount === 1 ? "finding" : "findings"}
                </span>
                <span fg={THEME.fgDim}> [j/k] move [d/enter] drill [x] act [q] quit</span>
            </text>
        </box>
    );
}
