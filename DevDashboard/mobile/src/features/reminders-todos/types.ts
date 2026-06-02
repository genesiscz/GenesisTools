import type { TodoPriority, TodosResult } from "@dd/contract";

/**
 * Feature-local row/list types for the reminders-todos surface. `@dd/contract` re-exports
 * `TodosResult`/`TodoPriority` but NOT `ReminderInfo`/`ReminderListInfo` by name, so derive the row
 * + list shapes STRUCTURALLY off `TodosResult` — importing those names from `@dd/contract` would
 * fail to resolve (see plan §7 gotcha 1). The reminder fields are snake_case (`is_completed`,
 * `due_date`, `list_identifier`); `identifier` is the React key + testID suffix.
 */
export type Todo = TodosResult["reminders"][number];
export type TodoListInfo = TodosResult["lists"][number];

export interface AddTodoInput {
    title: string;
    /** Defaults server-side to "GenesisTools". */
    listName?: string;
    due?: string;
    priority?: TodoPriority;
    notes?: string;
}
