import { Input } from "@ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { FormDialog, FormField } from "@ui/custom";
import type React from "react";
import { useState } from "react";
import { CATEGORY_CONFIG, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/expenses/categories";
import type { CreateExpenseInput } from "@/lib/expenses/expenses.server";
import { parseDollarsToCents, todayLocalISO } from "@/lib/expenses/money";

interface AddExpenseFormProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (input: CreateExpenseInput) => Promise<void>;
    submitting?: boolean;
}

export function AddExpenseForm({ open, onOpenChange, onSubmit, submitting }: AddExpenseFormProps) {
    const [amount, setAmount] = useState("");
    const [category, setCategory] = useState<ExpenseCategory>("groceries");
    const [description, setDescription] = useState("");
    const [day, setDay] = useState(todayLocalISO());
    const [amountError, setAmountError] = useState<string | null>(null);

    function reset() {
        setAmount("");
        setCategory("groceries");
        setDescription("");
        setDay(todayLocalISO());
        setAmountError(null);
    }

    function handleOpenChange(value: boolean) {
        if (!value) {
            reset();
        }

        onOpenChange(value);
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();

        const cents = parseDollarsToCents(amount);
        if (cents === null) {
            setAmountError("Enter an amount greater than 0");
            return;
        }

        await onSubmit({
            amountCents: cents,
            currency: "USD",
            category,
            description: description.trim(),
            day,
        });
        handleOpenChange(false);
    }

    return (
        <FormDialog
            open={open}
            onOpenChange={handleOpenChange}
            title="Add expense"
            description="Log what you spent — amounts are stored to the cent."
            onSubmit={handleSubmit}
            submitLabel={submitting ? "Saving…" : "Add expense"}
            isSubmitting={submitting}
            submitDisabled={!amount.trim()}
            maxWidth="sm:max-w-md"
        >
            <div className="space-y-4">
                <FormField label="Amount" required error={amountError ?? undefined}>
                    <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                            $
                        </span>
                        <Input
                            data-testid="expense-amount-input"
                            inputMode="decimal"
                            value={amount}
                            onChange={(e) => {
                                setAmount(e.target.value);
                                setAmountError(null);
                            }}
                            placeholder="0.00"
                            className="pl-7 tabular-nums"
                            autoFocus
                        />
                    </div>
                </FormField>

                <FormField label="Category" required>
                    <Select value={category} onValueChange={(v: ExpenseCategory) => setCategory(v)}>
                        <SelectTrigger data-testid="expense-category-select" className="bg-background/50">
                            <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                        <SelectContent>
                            {EXPENSE_CATEGORIES.map((cat) => (
                                <SelectItem key={cat} value={cat}>
                                    <span className="flex items-center gap-2">
                                        <span
                                            aria-hidden
                                            className="h-2.5 w-2.5 rounded-full"
                                            style={{ backgroundColor: CATEGORY_CONFIG[cat].color }}
                                        />
                                        {CATEGORY_CONFIG[cat].label}
                                    </span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </FormField>

                <FormField label="Description" hint="Optional — what was it for?">
                    <Input
                        data-testid="expense-description-input"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Weekly groceries"
                    />
                </FormField>

                <FormField label="Date" required>
                    <Input
                        data-testid="expense-date-input"
                        type="date"
                        value={day}
                        max={todayLocalISO()}
                        onChange={(e) => setDay(e.target.value)}
                        className="tabular-nums"
                    />
                </FormField>
            </div>
        </FormDialog>
    );
}
