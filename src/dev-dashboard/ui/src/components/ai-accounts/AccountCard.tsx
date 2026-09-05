import type { AccountUsageSnapshot } from "@app/dev-dashboard/contract/ai-accounts";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { useState } from "react";
import { providerMeta } from "@/lib/provider-meta";
import { LimitBar } from "./LimitBar";
import { ProviderBadge } from "./ProviderBadge";

interface AccountCardProps {
    snapshot: AccountUsageSnapshot;
    /** Account colour from `assignAccountColors`, shared with charts and chips. */
    color: string;
    nowMs: number;
    /**
     * The provider's prominent windows (`AccountPresentation.prominentLimits`).
     * They are shown first; the rest sit behind a disclosure rather than being
     * dropped, so nothing a poll recorded becomes unreachable. Empty or absent
     * means every window is prominent.
     */
    prominentKeys?: readonly string[];
    /** Stagger index for the entrance animation. */
    index?: number;
}

function ErrorDetails({ error }: { error: string }) {
    return (
        <details className="text-[var(--dd-text-muted)]">
            <summary className="cursor-pointer select-none text-xs hover:text-[var(--dd-text-secondary)]">
                details
            </summary>
            <p className="mt-1 break-words font-mono text-xs leading-relaxed">{error}</p>
        </details>
    );
}

function daysUntil(iso: string | undefined, nowMs: number): number | null {
    if (!iso) {
        return null;
    }

    const ms = new Date(iso).getTime() - nowMs;

    if (Number.isNaN(ms)) {
        return null;
    }

    return Math.ceil(ms / 86_400_000);
}

function HealthPill({ text, tone }: { text: string; tone: "warn" | "danger" | "muted" }) {
    const color =
        tone === "danger" ? "var(--dd-danger)" : tone === "warn" ? "var(--dd-warning)" : "var(--dd-text-muted)";

    return (
        <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}
        >
            {text}
        </span>
    );
}

/** One account of any provider: header with identity and health, then its limit windows. */
export function AccountCard({ snapshot, color, nowMs, prominentKeys, index = 0 }: AccountCardProps) {
    const [showAllWindows, setShowAllWindows] = useState(false);
    const meta = providerMeta(snapshot.provider);
    const title = snapshot.label ? `${snapshot.accountName} (${snapshot.label})` : snapshot.accountName;
    const prominent =
        prominentKeys && prominentKeys.length > 0
            ? snapshot.limits.filter((w) => prominentKeys.includes(w.key))
            : snapshot.limits;
    // A provider that names windows this account never reported would leave the
    // card blank, so fall back to everything rather than showing nothing.
    const limits = showAllWindows || prominent.length === 0 ? snapshot.limits : prominent;
    const hiddenWindows = snapshot.limits.length - limits.length;
    const staleAgo = snapshot.stale
        ? formatRelativeTime(new Date(snapshot.stale.lastSuccessAt), { compact: true })
        : null;
    const loginDays = daysUntil(snapshot.auth?.refreshExpiresAt, nowMs);
    const planDead = snapshot.plan?.status && snapshot.plan.status !== "active";

    return (
        <div
            className="dd-panel dd-ai-card dd-ai-fade-up flex flex-col gap-4 p-4"
            style={{ borderBottomColor: meta.color, animationDelay: `${Math.min(index, 12) * 40}ms` }}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <span className="dd-ai-dot" style={{ "--chip-color": color } as React.CSSProperties} />
                        <h3 className="dd-accent-text truncate text-lg font-semibold">{title}</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <ProviderBadge provider={snapshot.provider} />
                        {snapshot.plan?.name ? (
                            <span className="text-xs text-[var(--dd-text-muted)]">{snapshot.plan.name}</span>
                        ) : null}
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                    {staleAgo ? <HealthPill text={`stale · ${staleAgo}`} tone="warn" /> : null}
                    {snapshot.auth?.orgBlocked ? <HealthPill text="org blocked" tone="danger" /> : null}
                    {planDead ? <HealthPill text={`plan ${snapshot.plan?.status}`} tone="danger" /> : null}
                    {loginDays !== null && loginDays <= 7 ? (
                        <HealthPill
                            text={loginDays <= 0 ? "login expired" : `login ends in ${loginDays}d`}
                            tone={loginDays <= 2 ? "danger" : "warn"}
                        />
                    ) : null}
                </div>
            </div>

            {limits.length > 0 ? (
                <div className="flex flex-col gap-3">
                    {limits.map((window) => (
                        <LimitBar key={`${window.key}:${window.scopeModel ?? ""}`} window={window} nowMs={nowMs} />
                    ))}
                    {hiddenWindows > 0 ? (
                        <button
                            type="button"
                            className="self-start text-xs text-[var(--dd-text-muted)] underline-offset-2 hover:text-[var(--dd-text-primary)] hover:underline"
                            onClick={() => setShowAllWindows(true)}
                        >
                            {hiddenWindows} more window{hiddenWindows === 1 ? "" : "s"}
                        </button>
                    ) : null}
                    {showAllWindows && prominent.length > 0 && prominent.length < snapshot.limits.length ? (
                        <button
                            type="button"
                            className="self-start text-xs text-[var(--dd-text-muted)] underline-offset-2 hover:text-[var(--dd-text-primary)] hover:underline"
                            onClick={() => setShowAllWindows(false)}
                        >
                            show fewer
                        </button>
                    ) : null}
                    {snapshot.error ? <ErrorDetails error={snapshot.error} /> : null}
                </div>
            ) : snapshot.error ? (
                <div className="flex flex-col gap-1 text-sm">
                    <p className="font-medium text-[var(--dd-danger)]">Usage unavailable</p>
                    <ErrorDetails error={snapshot.error} />
                </div>
            ) : (
                <p className="text-sm text-[var(--dd-text-muted)]">No usage data.</p>
            )}

            <div className="flex items-center justify-between text-xs text-[var(--dd-text-muted)]">
                <span>fetched {formatRelativeTime(new Date(snapshot.fetchedAt), { compact: true })}</span>
                <span className="dd-ai-mono">{meta.alias}</span>
            </div>
        </div>
    );
}
