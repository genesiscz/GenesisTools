import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { AnimatedCard } from "@ui/custom";
import { Loader2, Trash2 } from "lucide-react";
import { categoryStyle } from "@/lib/expenses/categories";
import type { ExpenseRow } from "@/lib/expenses/expenses.server";
import { formatCents, formatDayLabel } from "@/lib/expenses/money";

interface ExpenseListProps {
    expenses: ExpenseRow[];
    onDelete: (id: string) => void;
    deletingId: string | null;
}

export function ExpenseList({ expenses, onDelete, deletingId }: ExpenseListProps) {
    return (
        <div className="flex flex-col gap-2" data-testid="expense-list">
            {expenses.map((expense, i) => {
                const style = categoryStyle(expense.category);
                const isDeleting = deletingId === expense.id;

                return (
                    <AnimatedCard key={expense.id} index={i} stagger={30}>
                        <Card
                            data-testid="expense-row"
                            className="group flex items-center gap-4 rounded-xl p-3.5 transition-colors hover:border-primary/30"
                        >
                            <span
                                aria-hidden
                                className="h-9 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: style.color }}
                            />

                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span
                                        className="rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide"
                                        style={{
                                            color: style.color,
                                            backgroundColor: `${style.color}1a`,
                                        }}
                                    >
                                        {style.label}
                                    </span>
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        {formatDayLabel(expense.day)}
                                    </span>
                                </div>
                                {expense.description ? (
                                    <p className="mt-1 truncate text-sm text-foreground/90">{expense.description}</p>
                                ) : (
                                    <p className="mt-1 truncate text-sm italic text-muted-foreground/50">
                                        No description
                                    </p>
                                )}
                            </div>

                            <span
                                className="shrink-0 text-base font-semibold tabular-nums text-foreground"
                                data-testid="expense-amount"
                            >
                                {formatCents(expense.amountCents, expense.currency)}
                            </span>

                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label="Delete expense"
                                data-testid="expense-delete"
                                disabled={isDeleting}
                                onClick={() => onDelete(expense.id)}
                                className="h-8 w-8 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                            >
                                {isDeleting ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Trash2 className="h-4 w-4" />
                                )}
                            </Button>
                        </Card>
                    </AnimatedCard>
                );
            })}
        </div>
    );
}
