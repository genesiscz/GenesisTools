/** @jsxImportSource @opentui/solid */
import type { Analyzer } from "@app/doctor/lib/analyzer";
import { Engine } from "@app/doctor/lib/engine";
import { executeActions } from "@app/doctor/lib/executor";
import type { Action, EngineEvent, Finding } from "@app/doctor/lib/types";
import logger from "@app/logger";
import { emptyTrash, type StageItem, stageItems } from "@app/utils/prompts/clack/trash-staging";
import * as p from "@app/utils/prompts/p";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createMemo, onCleanup, onMount, Show } from "solid-js";
import { Dashboard } from "./Dashboard";
import { FindingsDrawer } from "./FindingsDrawer";
import { PromptHost } from "./PromptHost";
import { useEngineStore } from "./stores/engine-store";
import { usePromptStore } from "./stores/prompt-store";
import { useStore } from "./stores/use-store";
import { Toolbar } from "./Toolbar";
import { TrashTray } from "./TrashTray";
import { THEME } from "./theme";

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
    const stagedItems = useStore(useEngineStore, (state) => state.stagedItems);
    const promptCount = useStore(usePromptStore, (state) => state.tasks.length);
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

        const deferred = setTimeout(() => {
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
        }, 0);

        onCleanup(() => {
            clearTimeout(deferred);
            engine.off("event", handleEvent);
        });
    });

    useKeyboard((key) => {
        if (promptCount() > 0) {
            return;
        }

        const store = useEngineStore.getState();

        // Global keys work regardless of drawer state.
        if (key.shift && key.name === "d") {
            void commitTrash({ dryRun: props.dryRun });
            return;
        }

        if (key.name === "x") {
            void executeSelected({ runId: props.runId, dryRun: props.dryRun });
            return;
        }

        // When the drawer is open, it owns navigation (j/k/up/down/space) and
        // its own close on q/escape. Don't process those here — the drawer's
        // own useKeyboard handler will.
        if (drawerOpen()) {
            return;
        }

        if (key.name === "q" || key.name === "escape") {
            renderer.destroy();
            return;
        }

        // OpenTUI emits `return` for the Enter key, not `enter`. Accept both.
        if (key.name === "d" || key.name === "return" || key.name === "enter") {
            store.setDrawer(true);
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
                        <FindingsDrawer
                            analyzerId={focusedAnalyzerId()}
                            findings={analyzerFindings()}
                            onClose={() => useEngineStore.getState().setDrawer(false)}
                        />
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
            <TrashTray items={stagedItems()} onCommit={() => commitTrash({ dryRun: props.dryRun })} />
            <PromptHost />
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

interface RuntimeOpts {
    runId: string;
    dryRun: boolean;
}

interface CommitTrashOpts {
    dryRun: boolean;
}

interface SelectedAction {
    finding: Finding;
    action: Action;
}

async function executeSelected(opts: RuntimeOpts): Promise<void> {
    const store = useEngineStore.getState();

    if (store.phase === "acting") {
        return;
    }

    const picks = Array.from(store.selectedFindingIds)
        .map((id) => store.findingsById.get(id))
        .filter((finding): finding is Finding => Boolean(finding));

    if (picks.length === 0) {
        p.log.info("No findings selected.");
        return;
    }

    store.setPhase("acting");

    try {
        const toExecute = await confirmSelectedActions(picks);
        const direct = toExecute.filter((item) => !item.action.staged);
        const staged = toExecute.filter((item) => item.action.staged);

        if (direct.length > 0) {
            await executeActions({
                runId: opts.runId,
                dryRun: opts.dryRun,
                items: direct,
            });
        }

        if (staged.length > 0) {
            await stageSelectedActions(staged, opts.dryRun);
        }

        store.clearSelection();
    } finally {
        useEngineStore.getState().setPhase("done");
    }
}

async function confirmSelectedActions(findings: Finding[]): Promise<SelectedAction[]> {
    const toExecute: SelectedAction[] = [];

    for (const finding of findings) {
        const action = finding.actions[0];

        if (!action) {
            continue;
        }

        if (action.confirm === "none") {
            toExecute.push({ finding, action });
            continue;
        }

        if (action.confirm === "yesno") {
            const confirmed = await p.confirm({
                message: `${action.label} - ${finding.title}?`,
                danger: finding.severity === "dangerous",
            });

            if (confirmed) {
                toExecute.push({ finding, action });
            }

            continue;
        }

        const confirmed = await p.typedConfirm({
            message: action.label,
            phrase: action.confirmPhrase ?? "DELETE",
            caseSensitive: true,
        });

        if (confirmed) {
            toExecute.push({ finding, action });
        }
    }

    return toExecute;
}

async function stageSelectedActions(items: SelectedAction[], dryRun: boolean): Promise<void> {
    const stagedItems = items
        .map((item) => toStageItem(item.finding))
        .filter((item): item is StageItem => Boolean(item));

    if (stagedItems.length === 0) {
        return;
    }

    if (dryRun) {
        p.log.info(`Dry run: would stage ${stagedItems.length} item(s) in Trash.`);
        return;
    }

    const result = await stageItems(stagedItems);

    if (result.staged.length > 0) {
        useEngineStore.getState().addStaged(result.staged);
    }

    for (const failure of result.failed) {
        p.log.error(`Could not stage ${failure.item.path}: ${failure.error}`);
    }
}

function toStageItem(finding: Finding): StageItem | null {
    const path = finding.metadata?.path;

    if (typeof path !== "string") {
        return null;
    }

    return {
        id: finding.id,
        path,
        bytes: finding.reclaimableBytes ?? 0,
        label: finding.title,
    };
}

async function commitTrash(opts: CommitTrashOpts): Promise<void> {
    const store = useEngineStore.getState();

    if (store.stagedItems.length === 0) {
        return;
    }

    const confirmed = await p.typedConfirm({
        message: "Empty the Trash to permanently remove staged items?",
        phrase: "DELETE",
        caseSensitive: true,
    });

    if (!confirmed) {
        return;
    }

    if (opts.dryRun) {
        p.log.info(`Dry run: would empty Trash for ${store.stagedItems.length} staged item(s).`);
        return;
    }

    const emptied = await emptyTrash();

    if (emptied) {
        useEngineStore.getState().clearStaged();
        p.log.success("Trash emptied.");
    } else {
        p.log.warn("Trash empty command reported failure. Check Finder.");
    }
}
