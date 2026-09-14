import { StatTile } from "@/ui/StatTile";

interface KpiCardProps {
    label: string;
    value: string;
    sub?: string;
    testID: string;
}

/**
 * Pulse KPI card. A thin pass-through over the shared `StatTile` primitive — kept as a named
 * feature component so the Pulse screen reads in domain terms and a future Pulse-specific tweak has
 * a home without touching the shared tile. The 2-up grid + `<testID>-value` come from `StatTile`.
 */
export function KpiCard({ label, value, sub, testID }: KpiCardProps) {
    return <StatTile label={label} value={value} sub={sub} testID={testID} />;
}
