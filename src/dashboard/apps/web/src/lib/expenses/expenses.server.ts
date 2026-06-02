import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { db, type Expense, expenses } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import { emitDomainEvent } from "@/lib/events/event-bus.server";

export type ExpenseRow = Expense;

export interface CreateExpenseInput {
    amountCents: number;
    currency: string;
    category: string;
    description: string;
    day: string;
}

export const listExpenses = createServerFn({ method: "GET" }).handler(async (): Promise<ExpenseRow[]> => {
    const userId = await requireUserId();
    try {
        return db
            .select()
            .from(expenses)
            .where(eq(expenses.userId, userId))
            .orderBy(desc(expenses.day), desc(expenses.createdAt))
            .all();
    } catch (err) {
        console.error("[expenses] listExpenses failed:", err);
        throw err;
    }
});

export const createExpense = createServerFn({ method: "POST" })
    .inputValidator((d: CreateExpenseInput) => d)
    .handler(async ({ data }): Promise<ExpenseRow> => {
        const userId = await requireUserId();
        try {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();

            db.insert(expenses)
                .values({
                    id,
                    userId,
                    amountCents: Math.round(data.amountCents),
                    currency: data.currency,
                    category: data.category,
                    description: data.description,
                    day: data.day,
                    createdAt: now,
                    updatedAt: now,
                })
                .run();

            const created = db.select().from(expenses).where(eq(expenses.id, id)).get();
            if (!created) {
                throw new Error("[expenses] createExpense: expense not found after insert");
            }

            emitDomainEvent(userId, "expenses", { type: "created" });

            return created;
        } catch (err) {
            console.error("[expenses] createExpense failed:", err);
            throw err;
        }
    });

export const deleteExpense = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            db.delete(expenses)
                .where(and(eq(expenses.id, data.id), eq(expenses.userId, userId)))
                .run();

            emitDomainEvent(userId, "expenses", { type: "deleted" });

            return { success: true };
        } catch (err) {
            console.error("[expenses] deleteExpense failed:", err);
            throw err;
        }
    });
