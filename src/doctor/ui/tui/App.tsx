import type { Analyzer } from "@app/doctor/lib/analyzer";
import { Engine } from "@app/doctor/lib/engine";
import type { EngineEvent } from "@app/doctor/lib/types";
import logger from "@app/logger";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createMemo, onCleanup, onMount, Show } from "solid-js";
import { Dashboard } from "./Dashboard";
import { useEngineStore } from "./stores/engine-store";
import { useStore } from "./stores/use-store";
import { THEME } from "./theme";
import { Toolbar } from "./Toolbar";

export interface AppProps {
    analyzers: Analyzer[];
    runId: string;
    dryRun: boolean;
    thorough: boolean;
    fresh: boolean;
}

export function App(props: AppProps) {
    const renderer = useRenderer();
    const phase = useStore(useEngineStore, (state) => state.phase);
    const events = useStore(useEngineStore, (state) => state.events);
    const findingsById = useStore(useEngineStore, (state) => state.findingsById);
    const focusedAnalyzerId = useStore(useEngineStore, (state) => state.focusedAnalyzerId);
    const drawerOpen = useStore(useEngineStore, (state) => state.drawerOpen);
    const analyzerFindings = createMemo(() =>
        Array.from(findingsById().values()).filter((finding) => finding.analyzerId === focusedAnalyzerId())
    );

    onMount(() => {
        const store = useEngineStore.getState();
        store.reset(props.analyzers[0]?.id ?? "");

        const engine = new Engine();
        const handleEvent = (event: EngineEvent): void => {
            useEngineStore.getState().applyEvent(event);
        };

        engine.on("event", handleEvent);
        engine
            .run(props.analyzers, {
                concurrency: props.thorough ? 8 : 4,
                thorough: props.thorough,
                fresh: props.fresh,
                runId: props.runId,
                dryRun: props.dryRun,
            })
            .catch((err) => {
                logger.error({ err }, "doctor TUI engine failed");
                useEngineStore.getState().setPhase("done");
            });

        onCleanup(() => {
            engine.off("event", handleEvent);
        });
    });

    useKeyboard((key) => {
        const store = useEngineStore.getState();

        if (drawerOpen() && (key.name === "q" || key.name === "escape")) {
            store.setDrawer(false);
            return;
        }

        if (key.name === "q" || key.name === "escape") {
            renderer.destroy();
            return;
        }

        if (key.name === "d" || key.name === "enter") {
            store.setDrawer(!drawerOpen());
            return;
        }

        if (key.name === "j" || key.name === "down") {
            store.setFocused(nextAnalyzer(focusedAnalyzerId(), props.analyzers, 1));
            return;
        }

        if (key.name === "k" || key.name === "up") {
            store.setFocused(nextAnalyzer(focusedAnalyzerId(), props.analyzers, -1));
        }
    });

    return (
        <box flexDirection="column" width="100%" height="100%" backgroundColor={THEME.bg}>
            <Toolbar phase={phase()} findingsCount={findingsById().size} />
            <box flexGrow={1} padding={1}>
                <Show
                    when={!drawerOpen()}
                    fallback={
                        <box flexDirection="column">
                            <text fg={THEME.accent}>{focusedAnalyzerId()}</text>
                            <text fg={THEME.fgDim}>{analyzerFindings().length} findings selected for drawer view</text>
                        </box>
                    }
                >
                    <Dashboard
                        analyzers={props.analyzers}
                        events={events()}
                        findingsById={findingsById()}
                        focusedAnalyzerId={focusedAnalyzerId()}
                    />
                </Show>
            </box>
        </box>
    );
}

function nextAnalyzer(currentId: string, analyzers: Analyzer[], direction: 1 | -1): string {
    if (analyzers.length === 0) {
        return currentId;
    }

    const currentIndex = analyzers.findIndex((analyzer) => analyzer.id === currentId);
    const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (normalizedIndex + direction + analyzers.length) % analyzers.length;
    return analyzers[nextIndex]?.id ?? currentId;
}
