import type { ProcessInfo, ProcessSort, ProcessesRes } from "@dd/contract";

/**
 * Feature-local re-exports + sort metadata for the Process Monitor surface. `@dd/contract` already
 * exports `ProcessInfo`/`ProcessSort`/`ProcessesRes` by name, so re-export them here so feature files
 * import from one place (`@/features/process-monitor/types`) rather than reaching into the contract.
 *
 * `SORTS` drives the two-segment SortToggle (RSS / Name); the labels are the visible segment text.
 */
export type { ProcessInfo, ProcessSort, ProcessesRes };

export interface SortOption {
    value: ProcessSort;
    label: string;
    testID: string;
}

export const SORTS: readonly SortOption[] = [
    { value: "rss", label: "RSS", testID: "process-monitor-sort-rss" },
    { value: "name", label: "Name", testID: "process-monitor-sort-name" },
] as const;
