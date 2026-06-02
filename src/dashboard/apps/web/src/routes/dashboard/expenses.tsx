import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { EmptyState, FloatingActionButton, PageLoadingSpinner } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { CalendarOff, Plus, Wallet } from "lucide-react";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { summarizeMonth } from "@/lib/expenses/derive";
import { expenseKeys } from "@/lib/expenses/expenses-keys";
import { EXPENSES_SYNC_CHANNEL, useExpenses } from "@/lib/expenses/hooks/useExpenses";
import { currentMonthKey, formatMonthLabel, monthOf } from "@/lib/expenses/money";
import { useServerEvents } from "@/lib/events/useServerEvents";
import { useBroadcastInvalidation } from "@/lib/sync/useBroadcastInvalidation";
import { AddExpenseForm, ExpenseList, MonthSelector, MonthSummary } from "./-expenses";

export const Route = createFileRoute("/dashboard/expenses")({
    component: ExpensesPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

const DEV_USER_ID = "dev-user";

function ExpensesPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const queryClient = useQueryClient();

    useBroadcastInvalidation(EXPENSES_SYNC_CHANNEL);
    useServerEvents({
        userId,
        domain: "expenses",
        onEvent: () => queryClient.invalidateQueries({ queryKey: expenseKeys.all }),
    });

    const { expenses, loading, initialized, addExpense, removeExpense, creating, deletingId } = useExpenses(userId);

    const [formOpen, setFormOpen] = useState(false);
    const [monthKey, setMonthKey] = useState(currentMonthKey());

    const summary = summarizeMonth(expenses, monthKey);
    const monthLabel = formatMonthLabel(monthKey);
    const hasAnyExpenses = expenses.length > 0;
    const hasMonthExpenses = summary.count > 0;

    if (authLoading || (!initialized && loading)) {
        return (
            <DashboardLayout title="Expenses" description="Track spending and see where money goes">
                <PageLoadingSpinner label="Loading expenses…" />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout title="Expenses" description="Track spending and see where your money goes">
            <div data-testid="expenses-page" className="flex flex-col gap-6">
                {!hasAnyExpenses ? (
                    <div data-testid="expenses-empty">
                        <EmptyState
                            icon={Wallet}
                            title="No expenses yet"
                            description="Log what you spend and watch a live breakdown of where your money goes each month."
                            cta={
                                <Button
                                    data-testid="add-expense-button"
                                    onClick={() => setFormOpen(true)}
                                    size="lg"
                                    variant="brand"
                                    className="mt-2 gap-2"
                                >
                                    <Plus className="h-5 w-5" />
                                    Add your first expense
                                </Button>
                            }
                        />
                    </div>
                ) : (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <MonthSelector monthKey={monthKey} onChange={setMonthKey} />
                            <Button
                                data-testid="add-expense-button"
                                onClick={() => setFormOpen(true)}
                                variant="brand"
                                className="gap-2"
                            >
                                <Plus className="h-4 w-4" />
                                Add expense
                            </Button>
                        </div>

                        {hasMonthExpenses ? (
                            <>
                                <MonthSummary summary={summary} monthLabel={monthLabel} />

                                <div className="flex flex-col gap-3">
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-sm font-semibold text-foreground">Transactions</h3>
                                        <span
                                            data-testid="expenses-total"
                                            className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50"
                                        >
                                            {summary.count} item{summary.count !== 1 ? "s" : ""} · {monthLabel}
                                        </span>
                                    </div>
                                    <ExpenseList
                                        expenses={summary.monthExpenses}
                                        onDelete={removeExpense}
                                        deletingId={deletingId ?? null}
                                    />
                                </div>
                            </>
                        ) : (
                            <div data-testid="expenses-month-empty">
                                <EmptyState
                                    icon={CalendarOff}
                                    title={`Nothing in ${monthLabel}`}
                                    description="No expenses recorded for this month. Pick another month or add one below."
                                    iconSize="md"
                                    rings={false}
                                    cta={
                                        <Button
                                            onClick={() => setFormOpen(true)}
                                            variant="outline"
                                            className="mt-2 gap-2"
                                        >
                                            <Plus className="h-4 w-4" />
                                            Add an expense
                                        </Button>
                                    }
                                />
                            </div>
                        )}
                    </>
                )}
            </div>

            {hasAnyExpenses && (
                <FloatingActionButton icon={Plus} onClick={() => setFormOpen(true)} label="Add expense" />
            )}

            <AddExpenseForm
                open={formOpen}
                onOpenChange={setFormOpen}
                submitting={creating}
                onSubmit={async (input) => {
                    const created = await addExpense(input);
                    if (created) {
                        setMonthKey(monthOf(created.day));
                    }
                }}
            />
        </DashboardLayout>
    );
}
