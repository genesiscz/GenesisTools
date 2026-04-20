/** @jsxImportSource @opentui/solid */
import { formatBytes } from "@app/doctor/lib/size";
import type { Finding } from "@app/doctor/lib/types";
import type { TextTableContent, TextTableRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { useEngineStore } from "./stores/engine-store";
import { useStore } from "./stores/use-store";
import { THEME } from "./theme";
import { viewForAnalyzer } from "./views";
import { toNativeContent } from "./views/native-content";
import { StatusStrip } from "./views/StatusStrip";
import type { Cell, ColumnSpec, Row } from "./views/types";

interface FindingsDrawerProps {
    analyzerId: string;
    findings: Finding[];
    onClose(): void;
}

const HEADER_BG = THEME.bgAlt;

function headerRow(columns: ColumnSpec[]): Row {
    return columns.map((col): Cell => [{ text: col.header, fg: THEME.fgDim, bg: HEADER_BG }]);
}

export function FindingsDrawer(props: FindingsDrawerProps) {
    const [cursor, setCursor] = createSignal(0);
    const [viewportRows] = createSignal(20);
    const selectedFindingIds = useStore(useEngineStore, (state) => state.selectedFindingIds);

    const view = createMemo(() => {
        const fn = viewForAnalyzer(props.analyzerId);
        return fn({
            findings: props.findings,
            selected: selectedFindingIds(),
            cursor: cursor(),
            viewportRows: viewportRows(),
        });
    });

    // full list — used for count, selection totals, and cursor → finding mapping
    // (view().actionable.findings is the visible page slice, used for rendering via rows)
    const allActionableFindings = createMemo(() => view().actionable.allFindings);
    const actionableCount = createMemo(() => allActionableFindings().length);
    const statusCount = createMemo(() => view().status.length);

    const selectedTotal = createMemo(() =>
        allActionableFindings()
            .filter((finding) => selectedFindingIds().has(finding.id))
            .reduce((total, finding) => total + (finding.reclaimableBytes ?? 0), 0)
    );

    createEffect(() => {
        const maxCursor = Math.max(0, actionableCount() - 1);

        if (cursor() > maxCursor) {
            setCursor(maxCursor);
        }
    });

    useKeyboard((key) => {
        if (key.name === "escape" || key.name === "q") {
            props.onClose();
            return;
        }

        if (actionableCount() === 0) {
            return;
        }

        if (key.name === "j" || key.name === "down") {
            setCursor((current) => Math.min(current + 1, actionableCount() - 1));
            return;
        }

        if (key.name === "k" || key.name === "up") {
            setCursor((current) => Math.max(0, current - 1));
            return;
        }

        if (key.name === "space") {
            const finding = allActionableFindings()[cursor()];

            if (!finding || finding.severity === "blocked") {
                return;
            }

            useEngineStore.getState().toggleFinding(finding.id);
        }
    });

    const tableContent = createMemo((): TextTableContent => {
        const v = view();
        return toNativeContent([headerRow(v.actionable.columns), ...v.actionable.rows]);
    });

    const [tableRef, setTableRef] = createSignal<TextTableRenderable | undefined>(undefined);

    createEffect(() => {
        const content = tableContent();
        const table = tableRef();

        if (table) {
            table.content = content;
        }
    });

    return (
        <box flexDirection="column" border borderStyle="rounded" borderColor={THEME.accent} padding={1} flexGrow={1}>
            <text>
                <span fg={THEME.accent}>
                    <strong>{props.analyzerId}</strong>
                </span>
                <span fg={THEME.fgDim}>{`  ·  ${actionableCount()} actionable`}</span>
                <Show when={statusCount() > 0}>
                    <span fg={THEME.fgDim}>{`  ·  ${statusCount()} status`}</span>
                </Show>
                <Show when={selectedTotal() > 0}>
                    <span fg={THEME.fgDim}>{"  ·  selected: "}</span>
                    <span fg={THEME.success}>{formatBytes(selectedTotal())}</span>
                </Show>
                <span fg={THEME.fgDim}>{"     [space] toggle  [j/k] move  [x] act  [esc] close"}</span>
            </text>

            <StatusStrip rows={view().status} />

            <Show
                when={actionableCount() > 0}
                fallback={
                    <box flexGrow={1} justifyContent="center" alignItems="center">
                        <text>
                            <span fg={THEME.fgDim}>Nothing to act on — this analyzer only reports status.</span>
                        </text>
                    </box>
                }
            >
                <text_table
                    ref={(el: TextTableRenderable) => setTableRef(el)}
                    wrapMode="none"
                    columnWidthMode="full"
                    columnFitter="balanced"
                    border={false}
                    outerBorder={false}
                    cellPadding={0}
                    flexGrow={1}
                />
            </Show>

            <Show when={actionableCount() > 0}>
                <text>
                    <span fg={THEME.fgDim}>{`cursor ${cursor() + 1} / ${actionableCount()}`}</span>
                </text>
            </Show>
        </box>
    );
}
