import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { AddTodoForm } from "@/features/reminders-todos/components/AddTodoForm";
import { PermissionBanner } from "@/features/reminders-todos/components/PermissionBanner";
import { TodoList } from "@/features/reminders-todos/components/TodoList";
import { useCompleteTodo, useTodos } from "@/features/reminders-todos/hooks";
import { MockBadge } from "@/ui/MockBadge";
import { Screen } from "@/ui/Screen";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/** Heuristic: a denial surfaces from the 503 branch as an Error whose message mentions permission. */
function isPermissionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : "";
    return /permission|denied|reminders/i.test(message);
}

/**
 * Reminders & Todos screen — lists incomplete macOS Reminders, adds one inline, and completes a row
 * by tapping its toggle (the list query invalidates → the completed item drops out). Composes the
 * feature off the per-feature `useTodos`/`useCompleteTodo` hooks (D32 — never raw useQuery).
 *
 * Uses `<Screen>` (a ScrollView, `displayed=true`) + a non-virtualized `.map()` of rows so the
 * `screen-reminders-todos` root stays displayed for Appium (a personal reminders list is short — see
 * plan §4.4 FlatList trap). On a 503 permission denial the screen renders `<PermissionBanner/>`
 * instead of the generic error.
 */
export default function RemindersTodosScreen() {
    const c = useThemeColors();
    const todosQuery = useTodos();
    const completeTodo = useCompleteTodo();
    const [completingId, setCompletingId] = useState<string | null>(null);

    const onComplete = (reminderId: string): void => {
        setCompletingId(reminderId);
        completeTodo.mutate(reminderId, {
            onSettled: () => setCompletingId(null),
        });
    };

    if (todosQuery.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Reminders" }} />
                <View
                    testID="screen-reminders-todos"
                    accessibilityLabel="screen-reminders-todos"
                    className="flex-1 items-center justify-center bg-dd-bg-base"
                >
                    <View testID="reminders-todos-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Loading reminders…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (todosQuery.isError && isPermissionError(todosQuery.error)) {
        return (
            <>
                <Stack.Screen options={{ title: "Reminders" }} />
                <Screen testID="screen-reminders-todos">
                    <MockBadge />
                    <SectionHeader title="Reminders" />
                    <PermissionBanner />
                </Screen>
            </>
        );
    }

    if (todosQuery.isError || !todosQuery.data) {
        return (
            <>
                <Stack.Screen options={{ title: "Reminders" }} />
                <View
                    testID="screen-reminders-todos"
                    accessibilityLabel="screen-reminders-todos"
                    className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6"
                >
                    <Text
                        testID="reminders-todos-error"
                        className="text-base font-bold"
                        style={{ color: c.danger, fontFamily: "monospace" }}
                    >
                        Reminders unavailable
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {todosQuery.error instanceof Error ? todosQuery.error.message : "Could not reach the agent."}
                    </Text>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: "Reminders" }} />
            <Screen testID="screen-reminders-todos">
                <MockBadge />
                <SectionHeader title="Reminders" />
                <AddTodoForm />
                <TodoList todos={todosQuery.data.reminders} completingId={completingId} onComplete={onComplete} />
            </Screen>
        </>
    );
}
