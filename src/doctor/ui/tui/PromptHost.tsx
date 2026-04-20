/** @jsxImportSource @opentui/solid */
import type { SelectValue } from "@app/utils/prompts/p";
import { completeTask } from "@app/utils/prompts/p/opentui-backend";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, type Setter, Show } from "solid-js";
import { Modal } from "./Modal";
import type { PromptTask } from "./stores/prompt-store";
import { usePromptStore } from "./stores/prompt-store";
import { useStore } from "./stores/use-store";
import { THEME } from "./theme";

function isEnter(keyName: string): boolean {
    return keyName === "enter" || keyName === "return";
}

function isPrintableKey(sequence: string): boolean {
    return sequence.length === 1;
}

function selectFallback(task: Extract<PromptTask, { type: "select" }>): SelectValue {
    return task.opts.initialValue ?? task.opts.options[0]?.value ?? "";
}

function multiSelectFallback(task: Extract<PromptTask, { type: "multiselect" }>): SelectValue[] {
    return task.opts.initialValues ?? [];
}

export function PromptHost() {
    const tasks = useStore(usePromptStore, (state) => state.tasks);
    const current = createMemo(() => tasks()[0]);
    const [textInput, setTextInput] = createSignal("");
    const [validationMessage, setValidationMessage] = createSignal("");
    const [cursor, setCursor] = createSignal(0);
    const [selected, setSelected] = createSignal<Set<SelectValue>>(new Set());

    createEffect(() => {
        const task = current();
        setTextInput(task?.type === "text" ? (task.opts.initialValue ?? "") : "");
        setValidationMessage("");
        setCursor(initialCursor(task));
        setSelected(new Set(task?.type === "multiselect" ? (task.opts.initialValues ?? []) : []));
    });

    useKeyboard((key) => {
        const task = current();

        if (!task) {
            return;
        }

        if (task.type === "confirm") {
            if (key.name === "y" || isEnter(key.name)) {
                completeTask(task.id, true);
                return;
            }

            if (key.name === "n" || key.name === "escape") {
                completeTask(task.id, false);
            }

            return;
        }

        if (task.type === "text") {
            if (isEnter(key.name)) {
                const validation = task.opts.validate?.(textInput());

                if (validation) {
                    setValidationMessage(validation);
                    return;
                }

                completeTask(task.id, textInput());
                return;
            }

            if (key.name === "escape") {
                completeTask(task.id, task.opts.initialValue ?? "");
                return;
            }

            updateTextInput(key.name, key.sequence, key.ctrl, key.meta, setTextInput);
            return;
        }

        if (task.type === "typedConfirm") {
            if (isEnter(key.name)) {
                const expected = task.opts.caseSensitive === false ? task.opts.phrase.toLowerCase() : task.opts.phrase;
                const actual = task.opts.caseSensitive === false ? textInput().toLowerCase() : textInput();
                completeTask(task.id, actual === expected);
                return;
            }

            if (key.name === "escape") {
                completeTask(task.id, false);
                return;
            }

            updateTextInput(key.name, key.sequence, key.ctrl, key.meta, setTextInput);
            return;
        }

        if (task.type === "select") {
            if (key.name === "j" || key.name === "down") {
                setCursor((currentCursor) => Math.min(currentCursor + 1, task.opts.options.length - 1));
                return;
            }

            if (key.name === "k" || key.name === "up") {
                setCursor((currentCursor) => Math.max(0, currentCursor - 1));
                return;
            }

            if (isEnter(key.name)) {
                completeTask(task.id, task.opts.options[cursor()]?.value ?? selectFallback(task));
                return;
            }

            if (key.name === "escape") {
                completeTask(task.id, selectFallback(task));
            }

            return;
        }

        if (task.type === "multiselect") {
            if (key.name === "j" || key.name === "down") {
                setCursor((currentCursor) => Math.min(currentCursor + 1, task.opts.options.length - 1));
                return;
            }

            if (key.name === "k" || key.name === "up") {
                setCursor((currentCursor) => Math.max(0, currentCursor - 1));
                return;
            }

            if (key.name === "space") {
                const value = task.opts.options[cursor()]?.value;

                if (value === undefined) {
                    return;
                }

                setSelected((currentSelected) => {
                    const next = new Set(currentSelected);

                    if (next.has(value)) {
                        next.delete(value);
                    } else {
                        next.add(value);
                    }

                    return next;
                });
                return;
            }

            if (isEnter(key.name)) {
                completeTask(task.id, Array.from(selected()));
                return;
            }

            if (key.name === "escape") {
                completeTask(task.id, multiSelectFallback(task));
            }
        }
    });

    return (
        <Show when={current()}>
            {(task) => renderPrompt(task(), textInput(), validationMessage(), cursor(), selected())}
        </Show>
    );
}

function renderPrompt(
    task: PromptTask,
    textInput: string,
    validationMessage: string,
    cursor: number,
    selected: Set<SelectValue>
) {
    if (task.type === "text") {
        return renderTextPrompt(task, textInput, validationMessage);
    }

    if (task.type === "confirm" || task.type === "typedConfirm") {
        return renderConfirmPrompt(task, textInput);
    }

    return renderSelectionPrompt(task, cursor, selected);
}

function renderTextPrompt(task: Extract<PromptTask, { type: "text" }>, textInput: string, validationMessage: string) {
    return (
        <Modal title="Input">
            <text fg={THEME.fg}>{task.opts.message}</text>
            <text fg={THEME.fg}>
                &gt; {textInput}
                <span fg={THEME.fgDim}>{textInput ? "" : (task.opts.placeholder ?? "")}</span>
            </text>
            <Show when={validationMessage}>
                <text fg={THEME.danger}>{validationMessage}</text>
            </Show>
            <text fg={THEME.fgDim}>[enter] submit [esc] cancel</text>
        </Modal>
    );
}

function renderConfirmPrompt(task: Extract<PromptTask, { type: "confirm" | "typedConfirm" }>, textInput: string) {
    if (task.type === "typedConfirm") {
        return (
            <Modal title="Type to Confirm">
                <text fg={THEME.fg}>{task.opts.message}</text>
                <text fg={THEME.fgDim}>
                    Type: <span fg={THEME.accent}>{task.opts.phrase}</span>
                </text>
                <text fg={THEME.fg}>&gt; {textInput}</text>
                <text fg={THEME.fgDim}>[enter] submit [esc] cancel</text>
            </Modal>
        );
    }

    return (
        <Modal title="Confirm">
            <text fg={task.opts.danger ? THEME.danger : THEME.fg}>{task.opts.message}</text>
            <text fg={THEME.fgDim}>[y] yes [n] no [esc] cancel</text>
        </Modal>
    );
}

function renderSelectionPrompt(
    task: Extract<PromptTask, { type: "select" | "multiselect" }>,
    cursor: number,
    selected: Set<SelectValue>
) {
    return (
        <Modal title={task.type === "multiselect" ? "Select Multiple" : "Select One"}>
            <text fg={THEME.fg}>{task.opts.message}</text>
            <scrollbox flexGrow={1}>
                <For each={task.opts.options}>
                    {(option, index) => {
                        const isCursor = createMemo(() => index() === cursor);
                        const isSelected = createMemo(() => selected.has(option.value));
                        const marker = createMemo(() => {
                            if (task.type === "multiselect") {
                                return isSelected() ? "*" : "o";
                            }

                            return isCursor() ? "*" : " ";
                        });

                        return (
                            <text>
                                <span fg={isCursor() ? THEME.accent : THEME.fgDim}>{isCursor() ? "> " : "  "}</span>
                                <span fg={isSelected() ? THEME.success : THEME.fg}>
                                    {marker()} {option.label}
                                </span>
                                <span fg={THEME.fgDim}>{option.hint ? ` ${option.hint}` : ""}</span>
                            </text>
                        );
                    }}
                </For>
            </scrollbox>
            <text fg={THEME.fgDim}>
                {task.type === "multiselect"
                    ? "[space] toggle  [enter] done  [esc] cancel"
                    : "[enter] select  [esc] cancel"}
            </text>
        </Modal>
    );
}

function initialCursor(task: PromptTask | undefined): number {
    if (task?.type !== "select") {
        return 0;
    }

    const index = task.opts.options.findIndex((option) => option.value === task.opts.initialValue);
    return Math.max(0, index);
}

function updateTextInput(
    keyName: string,
    sequence: string,
    ctrl: boolean,
    meta: boolean,
    setTextInput: Setter<string>
): void {
    if (keyName === "backspace") {
        setTextInput((value) => value.slice(0, -1));
        return;
    }

    if (isPrintableKey(sequence) && !ctrl && !meta) {
        setTextInput((value) => value + sequence);
    }
}
