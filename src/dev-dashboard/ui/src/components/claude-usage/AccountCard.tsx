import type { AccountUsage } from "@app/claude/lib/usage/api";
import { normalizeLimits } from "@app/claude/lib/usage/limits";
import { formatAccountTitle } from "./account-title";
import { BucketBar } from "./BucketBar";

interface AccountCardProps {
    account: AccountUsage;
}

export function AccountCard({ account }: AccountCardProps) {
    const title = formatAccountTitle(account.accountName, account.label);
    const usage = account.usage;
    const limits = usage ? normalizeLimits(usage) : [];

    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <h3 className="dd-accent-text text-lg font-semibold">{title}</h3>
            {account.error ? (
                <div className="flex flex-col gap-1 text-sm">
                    <p className="font-medium text-[#f87171]">Cloud usage unavailable</p>
                    <details className="text-[var(--dd-text-muted)]">
                        <summary className="cursor-pointer select-none text-xs hover:text-[var(--dd-text-secondary)]">
                            details
                        </summary>
                        <p className="mt-1 break-words font-mono text-xs leading-relaxed">{account.error}</p>
                    </details>
                </div>
            ) : usage ? (
                <div className="flex flex-col gap-3">
                    {limits.map((limit) => (
                        <BucketBar
                            key={`${limit.bucket}:${limit.scope_model ?? ""}`}
                            bucket={limit.bucket}
                            scopeModel={limit.scope_model}
                            utilization={limit.percent}
                            resetsAt={limit.resets_at}
                        />
                    ))}
                </div>
            ) : (
                <p className="text-sm text-[var(--dd-text-muted)]">No usage data.</p>
            )}
        </div>
    );
}
