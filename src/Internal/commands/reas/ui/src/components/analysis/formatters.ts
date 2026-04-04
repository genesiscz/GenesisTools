import type { ReactNode } from "react";

export {
    fmt,
    fmtCompactCurrency,
    fmtCurrency,
    fmtDays,
    fmtInteger,
    fmtK,
    fmtM,
    fmtPercentile,
    type PercentOptions,
    pct,
} from "../../lib/format";

export function renderMaybe(value: ReactNode | null | undefined, fallback = "-"): ReactNode {
    if (value == null || value === "") {
        return fallback;
    }

    return value;
}
