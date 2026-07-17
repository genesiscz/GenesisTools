import { logger } from "@app/logger/client";
import { Button } from "@app/utils/ui/components/button";
import { computeCreditBuckets, subscriptionRenewalCopy } from "@app/utils/ui/components/youtube/billing-ui";
import { Diamond, formatDiamonds } from "@app/utils/ui/components/youtube/diamond";
import { SUBSCRIPTION_PLANS } from "@app/youtube/lib/billing.types";
import type { MeBillingContext, YtUser } from "@app/youtube/lib/types";
import { useMe, useSubscribe } from "@ext/api.hooks";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";

const PLAN = SUBSCRIPTION_PLANS[0];

/**
 * Subscription surface for the account/settings panel (spec §4.2): shows the
 * active plan with a RESETTING allowance-vs-top-up split, renewal/cancel state
 * — or a subscribe CTA when the user isn't a member. The allowance bucket
 * claws back each period; the top-up bucket survives, and the split bar makes
 * that visible so nobody expects diamonds to stack month over month.
 */
export function SubscriptionSection() {
    const me = useMe();
    const user = me.data?.user;
    const billing = me.data?.billing;

    if (!user || !billing) {
        return null;
    }

    const subscription = billing.subscription;

    if (subscription && subscription.status !== "canceled") {
        return <ActivePlan user={user} subscription={subscription} />;
    }

    return <SubscribeCta />;
}

function ActivePlan({
    user,
    subscription,
}: {
    user: YtUser;
    subscription: NonNullable<MeBillingContext["subscription"]>;
}) {
    const buckets = computeCreditBuckets({ credits: user.credits, subscription });
    const renewal = subscriptionRenewalCopy(subscription);
    const pastDue = subscription.status === "past_due";
    // Bar segments are sized against the plan allowance so a fully-spent
    // allowance visibly empties (top-up still shows beyond it).
    const scale = Math.max(buckets.allowance, buckets.total, 1);
    const allowancePct = (buckets.allowanceRemaining / scale) * 100;
    const topupPct = (buckets.topup / scale) * 100;

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">subscription</p>
                <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.18em] ${
                        pastDue
                            ? "border-destructive/40 text-destructive"
                            : "border-primary/30 bg-primary/5 text-primary"
                    }`}
                >
                    {pastDue ? "past due" : "active"}
                </span>
            </div>

            <div className="rounded-2xl border border-white/8 bg-black/20 p-3">
                <div className="flex items-center gap-2">
                    <Diamond size={18} glow />
                    <p className="text-sm font-semibold text-foreground/95">Monthly · ${PLAN.usd}/mo</p>
                    {renewal ? (
                        <span className="ml-auto inline-flex items-center gap-1 font-mono text-[12px] text-muted-foreground">
                            <RefreshCw className="size-3" /> {renewal}
                        </span>
                    ) : null}
                </div>

                <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-white/5">
                    <div className="h-full bg-primary/70" style={{ width: `${allowancePct}%` }} />
                    <div className="h-full bg-secondary/60" style={{ width: `${topupPct}%` }} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <span className="size-2 rounded-full bg-primary/70" aria-hidden />
                        <span className="tabular-nums text-foreground">
                            {formatDiamonds(buckets.allowanceRemaining)}
                        </span>
                        {" / "}
                        {formatDiamonds(buckets.allowance)} allowance
                    </span>
                    {buckets.topup > 0 ? (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            <span className="size-2 rounded-full bg-secondary/60" aria-hidden />
                            <span className="tabular-nums text-foreground">+{formatDiamonds(buckets.topup)}</span>{" "}
                            top-up
                        </span>
                    ) : null}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                    Allowance resets to {formatDiamonds(buckets.allowance)} each period. Top-up diamonds carry over.
                </p>
                {subscription.cancelAtPeriodEnd ? (
                    <p className="mt-1 text-xs text-amber-300/80">
                        Cancels at period end — you keep access until then.
                    </p>
                ) : null}
            </div>
        </div>
    );
}

function SubscribeCta() {
    const subscribe = useSubscribe();
    const [error, setError] = useState<string | null>(null);

    async function start() {
        if (subscribe.isPending) {
            return;
        }

        setError(null);
        try {
            await subscribe.mutateAsync({ planId: PLAN.id });
        } catch (err) {
            logger.warn({ error: err }, "subscription-section: subscribe failed");
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    const unconfigured = error?.includes("not configured") || error?.includes("billing not configured");

    return (
        <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">subscription</p>
            {unconfigured ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-4">
                    <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">Subscriptions aren't configured on this server yet.</p>
                </div>
            ) : (
                <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/10 via-transparent to-secondary/10 p-4">
                    <div className="flex items-center gap-2">
                        <Diamond size={20} glow />
                        <p className="text-sm font-semibold text-foreground">
                            {formatDiamonds(PLAN.allowance)} diamonds / month
                        </p>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                        A fresh {formatDiamonds(PLAN.allowance)}-diamond allowance every period for ${PLAN.usd}/mo.
                        Cancel anytime.
                    </p>
                    <Button
                        size="sm"
                        className="mt-3 w-full"
                        disabled={subscribe.isPending}
                        onClick={() => void start()}
                    >
                        {subscribe.isPending ? (
                            <>
                                <Loader2 className="size-4 animate-spin" /> Opening…
                            </>
                        ) : (
                            <>
                                <Sparkles className="size-4" /> Subscribe · ${PLAN.usd}/mo
                            </>
                        )}
                    </Button>
                </div>
            )}
            {error && !unconfigured ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">{error}</p>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Low-balance nudge banner (spec §4.3) — surfaces when the billing context
 * flags `lowBalance`, steering the user to top-up/subscribe before an action
 * bounces. Rendered near the top of the account surface.
 */
export function LowBalanceNudge({ onGetDiamonds }: { onGetDiamonds?: () => void }) {
    const me = useMe();

    if (!me.data?.user || !me.data.billing?.lowBalance) {
        return null;
    }

    return (
        <div className="flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3">
            <Diamond size={20} glow />
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-amber-100/95">Running low on diamonds</p>
                <p className="text-xs text-amber-100/70">Top up or subscribe to keep summarizing and asking.</p>
            </div>
            {onGetDiamonds ? (
                <Button size="sm" className="shrink-0" onClick={onGetDiamonds}>
                    Get more
                </Button>
            ) : null}
        </div>
    );
}
