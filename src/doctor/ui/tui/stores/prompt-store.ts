import type {
    ConfirmOpts,
    MultiSelectOpts,
    SelectOpts,
    SelectValue,
    TextOpts,
    TypedConfirmOpts,
} from "@app/utils/prompts/p";
import { createStore } from "zustand/vanilla";

export type PromptTask =
    | { id: string; type: "text"; opts: TextOpts }
    | { id: string; type: "confirm"; opts: ConfirmOpts }
    | { id: string; type: "typedConfirm"; opts: TypedConfirmOpts }
    | { id: string; type: "select"; opts: SelectOpts }
    | { id: string; type: "multiselect"; opts: MultiSelectOpts };

export type PromptTaskValue = string | boolean | SelectValue | SelectValue[];

export interface PromptState {
    tasks: PromptTask[];
    enqueue(task: PromptTask): void;
    complete(id: string): void;
}

export const usePromptStore = createStore<PromptState>()((set) => ({
    tasks: [],
    enqueue: (task) => set((state) => ({ tasks: [...state.tasks, task] })),
    complete: (id) => set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) })),
}));

export const promptStore = usePromptStore;
