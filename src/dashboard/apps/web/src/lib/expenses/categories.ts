export const EXPENSE_CATEGORIES = [
    "groceries",
    "dining",
    "transport",
    "housing",
    "utilities",
    "shopping",
    "entertainment",
    "health",
    "travel",
    "subscriptions",
    "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

interface CategoryStyle {
    label: string;
    /** Hex used in chart Cells AND list dots — single source of truth. */
    color: string;
}

/**
 * One config consumed by both the list badge and the chart. Hardcoded hex is
 * the legitimate categorical-visualisation carve-out (see design-system doc).
 */
export const CATEGORY_CONFIG: Record<ExpenseCategory, CategoryStyle> = {
    groceries: { label: "Groceries", color: "#22c55e" },
    dining: { label: "Dining", color: "#f97316" },
    transport: { label: "Transport", color: "#06b6d4" },
    housing: { label: "Housing", color: "#a855f7" },
    utilities: { label: "Utilities", color: "#eab308" },
    shopping: { label: "Shopping", color: "#ec4899" },
    entertainment: { label: "Entertainment", color: "#8b5cf6" },
    health: { label: "Health", color: "#ef4444" },
    travel: { label: "Travel", color: "#3b82f6" },
    subscriptions: { label: "Subscriptions", color: "#14b8a6" },
    other: { label: "Other", color: "#64748b" },
};

export function isExpenseCategory(value: string): value is ExpenseCategory {
    return (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

export function categoryStyle(category: string): CategoryStyle {
    return isExpenseCategory(category) ? CATEGORY_CONFIG[category] : CATEGORY_CONFIG.other;
}
