import { Feather } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";
import type { Todo } from "@/features/reminders-todos/types";

interface Props {
    todo: Todo;
    /** Disabled while the complete mutation for this row is in flight. */
    completing: boolean;
    onComplete: (reminderId: string) => void;
}

/** Apple EKReminderPriority integers → a short label (1 high / 5 medium / 9 low / 0 none). */
function priorityLabel(priority: number): string | null {
    if (priority === 1) {
        return "High";
    }

    if (priority === 5) {
        return "Medium";
    }

    if (priority === 9) {
        return "Low";
    }

    return null;
}

/** Local date label for a due timestamp (ISO). Returns null for an unparseable/absent value. */
function dueLabel(due: string | undefined): string | null {
    if (!due) {
        return null;
    }

    const date = new Date(due);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * One reminder row (feature-local Tier-2 — the shared `ListRow` has no LEADING control slot, and is
 * a shared primitive this feature must not modify). Leading complete toggle (an empty circle that
 * the user taps to mark done), the title, and optional due/priority pills.
 */
export function TodoRow({ todo, completing, onComplete }: Props) {
    const c = useThemeColors();
    const due = dueLabel(todo.due_date);
    const priority = priorityLabel(todo.priority);

    return (
        <View
            testID={`reminders-todos-row-${todo.identifier}`}
            accessibilityLabel={`reminders-todos-row-${todo.identifier}`}
            className="flex-row items-center gap-3 py-2"
        >
            <Pressable
                testID={`reminders-todos-complete-${todo.identifier}`}
                accessibilityRole="button"
                accessibilityLabel={`complete ${todo.title}`}
                disabled={completing}
                onPress={() => onComplete(todo.identifier)}
                hitSlop={8}
            >
                <Feather
                    name={todo.is_completed ? "check-circle" : "circle"}
                    size={20}
                    color={todo.is_completed ? c.accent : c.textMuted}
                />
            </Pressable>

            <Text numberOfLines={2} className="flex-1" style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                {todo.title}
            </Text>

            {priority ? <StatusPill label={priority} tone="muted" /> : null}
            {due ? <StatusPill label={due} tone="muted" /> : null}
        </View>
    );
}
