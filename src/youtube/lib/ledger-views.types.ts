export interface UsageDay {
    date: string;
    spent: number;
    earned: number;
}

export interface UsageByReason {
    reason: string;
    spent: number;
    count: number;
}

export interface UsageSummary {
    days: UsageDay[];
    byReason: UsageByReason[];
    month: { spent: number; earned: number };
}

export interface LedgerRowData {
    id: number;
    delta: number;
    reason: string;
    balanceAfter: number;
    createdAt: string;
    context: string | null;
}

export interface LedgerPage {
    rows: LedgerRowData[];
    nextBefore: number | null;
}
