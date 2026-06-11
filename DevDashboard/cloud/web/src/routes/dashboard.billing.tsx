import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card, SectionTitle } from "@/components/dashboard/Card";
import { Check } from "@/components/landing/icons";
import { getBilling, openBillingPortal, startCheckout } from "@/lib/billing/billing.functions";
import { PRICING_PLANS } from "@/content/copy";

type PaidTier = "pro" | "team";

export const Route = createFileRoute("/dashboard/billing")({
    loader: () => getBilling(),
    component: BillingPage,
});

function BillingPage() {
    const billing = Route.useLoaderData();
    const [note, setNote] = useState<string | null>(null);
    const [pendingTier, setPendingTier] = useState<PaidTier | "portal" | null>(null);

    async function onCheckout(tier: PaidTier) {
        setNote(null);
        setPendingTier(tier);

        try {
            const result = await startCheckout({ data: { tier } });

            if (result.url) {
                window.location.href = result.url;
                return;
            }

            setNote(result.note ?? "Checkout is unavailable right now.");
        } catch (err) {
            setNote(err instanceof Error ? err.message : "Could not start checkout.");
        } finally {
            setPendingTier(null);
        }
    }

    async function onManage() {
        setNote(null);
        setPendingTier("portal");

        try {
            const result = await openBillingPortal();

            if (result.url) {
                window.location.href = result.url;
                return;
            }

            setNote(result.note ?? "The billing portal is unavailable right now.");
        } catch (err) {
            setNote(err instanceof Error ? err.message : "Could not open the billing portal.");
        } finally {
            setPendingTier(null);
        }
    }

    return (
        <div>
            <SectionTitle
                title="Billing"
                subtitle="Self-host stays free forever. Paid tiers add managed remote and convenience — never the price of privacy."
            />

            <Card className="reveal in">
                <div className="flex flex-wrap items-start justify-between gap-4" data-testid={`billing-tier-${billing.tier}`}>
                    <div>
                        <p className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">Current plan</p>
                        <p
                            className="mt-2 font-display text-3xl font-semibold capitalize text-zinc-50"
                            data-testid="billing-current-tier"
                        >
                            {billing.tier}
                        </p>
                        <p className="mt-1 font-mono text-[12px] text-zinc-600" data-testid="billing-status">
                            status: {billing.status}
                            {billing.currentPeriodEnd ? ` · renews ${billing.currentPeriodEnd}` : ""}
                        </p>
                    </div>

                    {billing.hasStripeCustomer && (
                        <button
                            type="button"
                            onClick={onManage}
                            disabled={pendingTier !== null}
                            data-testid="billing-manage"
                            className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-300 backdrop-blur-xl transition-colors duration-500 ease-silk hover:bg-white/[0.06] hover:text-zinc-100 active:scale-[0.97] disabled:opacity-50"
                        >
                            {pendingTier === "portal" ? "Opening…" : "Manage billing"}
                        </button>
                    )}
                </div>

                {!billing.configured && (
                    <div
                        className="mt-5 rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-4 py-3"
                        data-testid="billing-demo-banner"
                    >
                        <p className="font-mono text-[11px] uppercase tracking-wider text-amber-300/90">Demo mode</p>
                        <p className="mt-1 text-sm leading-relaxed text-amber-200/80">
                            Stripe is not configured in this environment. You can explore the plans below, but
                            checkout is disabled until <span className="font-mono">STRIPE_SECRET_KEY</span> is set.
                        </p>
                    </div>
                )}
            </Card>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
                {PRICING_PLANS.filter((plan) => plan.tier !== "free").map((plan) => {
                    const tier = plan.tier as PaidTier;
                    const isCurrent = billing.tier === tier;

                    return (
                        <Card key={plan.tier} className="reveal in">
                            <div className="flex items-baseline justify-between" data-testid={`billing-plan-${plan.tier}`}>
                                <h2 className="font-display text-lg font-semibold text-zinc-100">{plan.name}</h2>
                                <p className="font-display text-xl font-semibold text-zinc-50">
                                    {plan.price}
                                    <span className="ml-1 font-sans text-[11px] font-normal text-zinc-600">
                                        {plan.cadence}
                                    </span>
                                </p>
                            </div>
                            <p className="mt-1 text-sm text-zinc-500">{plan.subtitle}</p>

                            <ul className="mt-5 space-y-2.5">
                                {plan.features.map((feature) => (
                                    <li key={feature} className="flex items-start gap-2.5 text-sm text-zinc-300">
                                        <Check className="mt-1 h-3 w-3 shrink-0 text-emerald-400" />
                                        <span>{feature}</span>
                                    </li>
                                ))}
                            </ul>

                            <button
                                type="button"
                                onClick={() => onCheckout(tier)}
                                disabled={isCurrent || pendingTier !== null}
                                data-testid={`billing-upgrade-${plan.tier}`}
                                className="mt-7 w-full rounded-full bg-emerald-400 py-2.5 text-sm font-medium text-emerald-950 transition-transform duration-500 ease-silk active:scale-[0.98] disabled:cursor-default disabled:bg-white/[0.06] disabled:text-zinc-400"
                            >
                                {isCurrent
                                    ? "Current plan"
                                    : pendingTier === tier
                                      ? "Starting…"
                                      : `Upgrade to ${plan.name}`}
                            </button>
                        </Card>
                    );
                })}
            </div>

            {note && (
                <div className="mt-6">
                    <Card>
                        <p className="font-mono text-[12px] leading-relaxed text-amber-200/80" data-testid="billing-note">
                            {note}
                        </p>
                    </Card>
                </div>
            )}
        </div>
    );
}
