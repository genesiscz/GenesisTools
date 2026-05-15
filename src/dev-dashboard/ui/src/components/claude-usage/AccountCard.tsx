import type { AccountUsage } from "@app/claude/lib/usage/api";
import { BucketBar } from "./BucketBar";

interface AccountCardProps {
    account: AccountUsage;
}

const BUCKET_ORDER = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"] as const;

export function AccountCard({ account }: AccountCardProps) {
    const title = account.label ?? account.accountName;
    const usage = account.usage;

    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <h3 className="dd-accent-text text-lg font-semibold">{title}</h3>
            {account.error ? (
                <p className="text-sm text-[#f87171]">{account.error}</p>
            ) : usage ? (
                <div className="flex flex-col gap-3">
                    {BUCKET_ORDER.map((bucket) => {
                        const data = usage[bucket];
                        if (!data) {
                            return null;
                        }

                        return (
                            <BucketBar
                                key={bucket}
                                bucket={bucket}
                                utilization={data.utilization}
                                resetsAt={data.resets_at}
                            />
                        );
                    })}
                </div>
            ) : (
                <p className="text-sm text-[var(--dd-text-muted)]">No usage data.</p>
            )}
        </div>
    );
}
