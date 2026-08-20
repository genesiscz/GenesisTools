import { Card } from "@/ui/Card";
import { Empty } from "@/ui/Empty";
import { TodoRow } from "@/features/reminders-todos/components/TodoRow";
import type { Todo } from "@/features/reminders-todos/types";

interface Props {
    todos: Todo[];
    /** The reminderId currently being completed (its row's toggle is disabled), or null. */
    completingId: string | null;
    onComplete: (reminderId: string) => void;
}

/**
 * The reminders list — one `TodoRow` per reminder inside a `<Card>`, or the shared `<Empty/>` when
 * there are none. Non-virtualized `.map()` (a personal reminders list is short) so the screen root
 * stays a `<Screen>` ScrollView with `displayed=true` for Appium (see plan §4.4 FlatList trap).
 */
export function TodoList({ todos, completingId, onComplete }: Props) {
    if (todos.length === 0) {
        return <Empty title="No reminders" hint="Add one above" testID="reminders-todos-empty" />;
    }

    return (
        <Card testID="reminders-todos-list" className="gap-0">
            {todos.map((todo) => (
                <TodoRow
                    key={todo.identifier}
                    todo={todo}
                    completing={completingId === todo.identifier}
                    onComplete={onComplete}
                />
            ))}
        </Card>
    );
}
