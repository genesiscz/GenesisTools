import type { AccountRef } from "@app/dev-dashboard/contract/ai-accounts";
import { SegmentedControl } from "@ui/components/segmented-control";
import { type AiAccountsFilters, RANGE_PRESETS, type RangePreset } from "@/lib/ai-accounts-filters";
import { PROVIDER_META, providerMeta } from "@/lib/provider-meta";
import { Chip } from "./Chip";

interface FilterBarProps {
    filters: AiAccountsFilters;
    accounts: AccountRef[];
    colors: Record<string, string>;
    onToggleProvider: (providerId: string) => void;
    onToggleAccount: (accountId: string) => void;
    onSetAccounts: (accountIds: string[]) => void;
    onSetRange: (range: AiAccountsFilters["range"]) => void;
    onReset: () => void;
}

function toLocalInput(iso: string | undefined): string {
    if (!iso) {
        return "";
    }

    const d = new Date(iso);

    if (Number.isNaN(d.getTime())) {
        return "";
    }

    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const INPUT_CLASS =
    "dd-ai-mono h-8 rounded-md border border-[var(--dd-border)] bg-transparent px-2 text-xs text-[var(--dd-text-primary)]";

const LINK_CLASS =
    "text-xs text-[var(--dd-text-muted)] underline-offset-2 hover:text-[var(--dd-text-primary)] hover:underline";

/**
 * Provider chips, account chips and the time range. Empty selections mean
 * "everything", so a fresh page shows all providers and all accounts.
 */
export function FilterBar({
    filters,
    accounts,
    colors,
    onToggleProvider,
    onToggleAccount,
    onSetAccounts,
    onSetRange,
    onReset,
}: FilterBarProps) {
    const providerActive = (id: string) => filters.providers.length === 0 || filters.providers.includes(id);
    const accountActive = (id: string) => filters.accountIds.length === 0 || filters.accountIds.includes(id);
    const visibleAccounts = accounts.filter((a) => providerActive(a.provider));
    const anyFilter = filters.providers.length > 0 || filters.accountIds.length > 0 || filters.range.preset !== "7d";

    return (
        <div className="dd-panel dd-ai-fade-up flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
                <span className="w-16 text-xs text-[var(--dd-text-muted)]">Provider</span>
                {PROVIDER_META.map((meta) => (
                    <Chip
                        key={meta.id}
                        pressed={providerActive(meta.id)}
                        color={meta.color}
                        label={meta.displayName}
                        title={meta.id}
                        onClick={() => onToggleProvider(meta.id)}
                    />
                ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <span className="w-16 text-xs text-[var(--dd-text-muted)]">Account</span>
                {visibleAccounts.length === 0 ? (
                    <span className="text-xs text-[var(--dd-text-muted)]">No accounts for the selected providers.</span>
                ) : null}
                {visibleAccounts.map((account) => (
                    <Chip
                        key={account.accountId}
                        pressed={accountActive(account.accountId)}
                        color={colors[account.accountId] ?? providerMeta(account.provider).color}
                        label={account.label ? `${account.accountName} (${account.label})` : account.accountName}
                        title={`${providerMeta(account.provider).displayName}: ${account.accountId}`}
                        onClick={() => onToggleAccount(account.accountId)}
                    />
                ))}
                {filters.accountIds.length > 0 ? (
                    <button type="button" className={LINK_CLASS} onClick={() => onSetAccounts([])}>
                        all
                    </button>
                ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <span className="w-16 text-xs text-[var(--dd-text-muted)]">Range</span>
                <SegmentedControl<RangePreset>
                    tone="dd"
                    aria-label="Time range"
                    className="w-auto"
                    value={filters.range.preset}
                    onValueChange={(preset) => onSetRange({ ...filters.range, preset })}
                    options={RANGE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                />
                {filters.range.preset === "custom" ? (
                    <div className="flex items-center gap-2 text-xs text-[var(--dd-text-muted)]">
                        <input
                            type="datetime-local"
                            aria-label="Range start"
                            className={INPUT_CLASS}
                            value={toLocalInput(filters.range.from)}
                            onChange={(e) =>
                                onSetRange({
                                    ...filters.range,
                                    from: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                                })
                            }
                        />
                        <span>to</span>
                        <input
                            type="datetime-local"
                            aria-label="Range end"
                            className={INPUT_CLASS}
                            value={toLocalInput(filters.range.to)}
                            onChange={(e) =>
                                onSetRange({
                                    ...filters.range,
                                    to: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                                })
                            }
                        />
                    </div>
                ) : null}
                {anyFilter ? (
                    <button type="button" className={`ml-auto ${LINK_CLASS}`} onClick={onReset}>
                        reset filters
                    </button>
                ) : null}
            </div>
        </div>
    );
}
