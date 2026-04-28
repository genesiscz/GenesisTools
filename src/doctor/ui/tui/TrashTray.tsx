/** @jsxImportSource @opentui/solid */
import { formatBytes } from "@app/doctor/lib/size";
import type { StageItem } from "@app/utils/prompts/clack/trash-staging";
import { For, Show } from "solid-js";
import { THEME } from "./theme";

interface TrashTrayProps {
    items: StageItem[];
    onCommit(): void;
}

export function TrashTray(props: TrashTrayProps) {
    const total = (): number => props.items.reduce((sum, item) => sum + item.bytes, 0);

    return (
        <Show when={props.items.length > 0}>
            <box
                border
                borderStyle="single"
                borderColor={THEME.warn}
                padding={1}
                flexDirection="column"
                onMouseDown={props.onCommit}
            >
                <text fg={THEME.warn}>
                    <strong>Staged Trash</strong>
                    <span fg={THEME.fgDim}>
                        {"  "}· {props.items.length} items · {formatBytes(total())} · [D] type DELETE to empty
                    </span>
                </text>
                <For each={props.items.slice(0, 5)}>
                    {(item) => (
                        <text fg={THEME.fgDim}>
                            {"  "}
                            {item.label ?? item.path} · {formatBytes(item.bytes)}
                        </text>
                    )}
                </For>
                <Show when={props.items.length > 5}>
                    <text fg={THEME.fgDim}> and {props.items.length - 5} more</text>
                </Show>
            </box>
        </Show>
    );
}
