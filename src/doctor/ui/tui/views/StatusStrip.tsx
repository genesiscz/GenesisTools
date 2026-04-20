/** @jsxImportSource @opentui/solid */
import { For, type JSX } from "solid-js";
import { THEME } from "../theme";
import type { StatusRow } from "./types";

interface StatusStripProps {
    rows: StatusRow[];
}

export function StatusStrip(props: StatusStripProps): JSX.Element | null {
    if (props.rows.length === 0) {
        return null;
    }

    const maxLabelWidth = Math.max(...props.rows.map((row) => row.label.length));

    return (
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <For each={props.rows}>
                {(row) => (
                    <text>
                        <span fg={THEME.fgDim}>{`${row.label.padEnd(maxLabelWidth)}  `}</span>
                        <span fg={row.valueFg ?? THEME.fg}>{row.value}</span>
                    </text>
                )}
            </For>
        </box>
    );
}
