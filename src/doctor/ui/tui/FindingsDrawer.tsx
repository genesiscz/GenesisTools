import { formatBytes } from "@app/doctor/lib/size";
import type { Finding } from "@app/doctor/lib/types";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For } from "solid-js";
import { useEngineStore } from "./stores/engine-store";
import { useStore } from "./stores/use-store";
import { THEME } from "./theme";

interface FindingsDrawerProps {
    analyzerId: string;
    findings: Finding[];
    onClose(): void;
}

function severityInk(severity: Finding["severity"]): string {
    if (severity === "safe") {
        return THEME.sevSafe;
    }

    if (severity === "cautious") {
        return THEME.sevCautious;
    }

    if (severity === "dangerous") {
        return THEME.sevDangerous;
    }

    return THEME.sevBlocked;
}

export function FindingsDrawer(props: FindingsDrawerProps) {
    const [cursor, setCursor] = createSignal(0);
    const selectedFindingIds = useStore(useEngineStore, (state) => state.selectedFindingIds);
    const selectedTotal = createMemo(() =>
        props.findings
            .filter((finding) => selectedFindingIds().has(finding.id))
            .reduce((total, finding) => total + (finding.reclaimableBytes ?? 0), 0)
    );

    createEffect(() => {
        const maxCursor = Math.max(0, props.findings.length - 1);

        if (cursor() > maxCursor) {
            setCursor(maxCursor);
        }
    });

    useKeyboard((key) => {
        if (key.name === "escape" || key.name === "q") {
            props.onClose();
            return;
        }

        if (key.name === "j" || key.name === "down") {
            setCursor((current) => Math.min(current + 1, props.findings.length - 1));
            return;
        }

        if (key.name === "k" || key.name === "up") {
            setCursor((current) => Math.max(0, current - 1));
            return;
        }

        if (key.name === "space") {
            const finding = props.findings[cursor()];

            if (!finding || finding.severity === "blocked") {
                return;
            }

            useEngineStore.getState().toggleFinding(finding.id);
        }
    });

    return (
        <box flexDirection="column" border borderStyle="rounded" borderColor={THEME.accent} padding={1}>
            <text>
                <span fg={THEME.accent}>
                    <strong>{props.analyzerId}</strong>
                </span>
                <span fg={THEME.fgDim}>  ·  {props.findings.length} findings</span>
                <span fg={THEME.fgDim}>  ·  selected: </span>
                <span fg={THEME.success}>{formatBytes(selectedTotal())}</span>
                <span fg={THEME.fgDim}>     [space] toggle  [esc] close</span>
            </text>
            <scrollbox flexGrow={1} focused>
                <For each={props.findings}>
                    {(finding, index) => {
                        const marker = createMemo(() => {
                            if (finding.severity === "blocked") {
                                return "x";
                            }

                            return selectedFindingIds().has(finding.id) ? "*" : "o";
                        });
                        const isCursor = createMemo(() => index() === cursor());
                        const bytes = createMemo(() =>
                            finding.reclaimableBytes ? ` · ${formatBytes(finding.reclaimableBytes)}` : ""
                        );
                        const reason = createMemo(() => (finding.blacklistReason ? ` (${finding.blacklistReason})` : ""));

                        return (
                            <text>
                                <span fg={isCursor() ? THEME.accent : THEME.fgDim}>{isCursor() ? "> " : "  "}</span>
                                <span fg={severityInk(finding.severity)}>{marker()}</span>
                                <span fg={THEME.fg}> {finding.title}</span>
                                <span fg={THEME.fgDim}>{bytes()}</span>
                                <span fg={THEME.sevBlocked}>{reason()}</span>
                            </text>
                        );
                    }}
                </For>
            </scrollbox>
        </box>
    );
}
