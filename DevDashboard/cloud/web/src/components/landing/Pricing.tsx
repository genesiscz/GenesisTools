import { Link } from "@tanstack/react-router";
import { PRICING_PLANS, PRICING_SECTION, type PricingPlan } from "@/content/copy";
import { ArrowRight, Check } from "./icons";

export function Pricing() {
    return (
        <section id="pricing" className="mx-auto max-w-7xl px-4 py-28 md:px-8 md:py-40">
            <div className="mx-auto max-w-3xl text-center">
                <span className="reveal mb-5 inline-block rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-violet-300/90">
                    {PRICING_SECTION.eyebrow}
                </span>
                <h2
                    className="reveal font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-zinc-50 md:text-5xl"
                    style={{ transitionDelay: "60ms" }}
                >
                    {PRICING_SECTION.titlePre}
                    <span className="grad-text">{PRICING_SECTION.titleGrad}</span>
                </h2>
                <p className="reveal mt-5 text-lg leading-relaxed text-zinc-400" style={{ transitionDelay: "120ms" }}>
                    {PRICING_SECTION.body}
                </p>
            </div>

            <div className="mt-16 grid items-stretch gap-5 lg:grid-cols-3">
                {PRICING_PLANS.map((plan, i) => (
                    <PlanCard key={plan.name} plan={plan} delay={`${i * 100}ms`} />
                ))}
            </div>
        </section>
    );
}

function PlanCard({ plan, delay }: { plan: PricingPlan; delay: string }) {
    const checkColor = plan.tier === "team" ? "#a78bfa" : "#34d399";

    if (plan.featured) {
        return (
            <div
                className="reveal rounded-[2.25rem] border border-emerald-400/25 bg-emerald-400/[0.04] p-1.5 backdrop-blur-xl lg:-mt-4 lg:mb-0"
                style={{ transitionDelay: delay }}
            >
                <div className="inset-hi relative flex h-full flex-col rounded-[calc(2.25rem-0.375rem)] bg-gradient-to-b from-[#0b1110] to-[#0a0b0d] p-8 ring-1 ring-emerald-400/20">
                    <span className="absolute right-7 top-8 rounded-full bg-emerald-400/15 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-400/30">
                        Popular
                    </span>
                    <h3 className="font-display text-xl font-semibold text-zinc-100">{plan.name}</h3>
                    <p className="mt-1 text-sm text-emerald-300/80">{plan.subtitle}</p>
                    <p className="mt-6 font-display text-5xl font-semibold text-zinc-50">
                        {plan.price}
                        <span className="text-lg font-medium text-zinc-500">{plan.cadence.split("·")[0]}</span>
                    </p>
                    <p className="mt-1 text-sm text-zinc-500">
                        {plan.cadence.includes("·") ? plan.cadence.split("·")[1]?.trim() : ""}
                    </p>
                    <PlanFeatures features={plan.features} checkColor={checkColor} bright />
                    <Link
                        to="/signup"
                        search={{ plan: plan.tier }}
                        className="group mt-8 flex items-center justify-center gap-2.5 rounded-full bg-emerald-400 py-3 pl-5 pr-2 text-[15px] font-medium text-emerald-950 transition-transform duration-500 ease-silk active:scale-[0.98]"
                    >
                        {plan.cta}
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-950/15 transition-transform duration-500 ease-silk group-hover:translate-x-1 group-hover:-translate-y-px">
                            <ArrowRight className="h-4 w-4" />
                        </span>
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div
            className="reveal rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl"
            style={{ transitionDelay: delay }}
        >
            <div className="inset-hi flex h-full flex-col rounded-[calc(2rem-0.375rem)] bg-[#0a0b0d] p-8 ring-1 ring-white/[0.06]">
                <h3 className="font-display text-xl font-semibold text-zinc-100">{plan.name}</h3>
                <p className="mt-1 text-sm text-zinc-500">{plan.subtitle}</p>
                <p className="mt-6 font-display text-5xl font-semibold text-zinc-50">
                    {plan.price}
                    {plan.cadence.startsWith("/") && (
                        <span className="text-lg font-medium text-zinc-500">{plan.cadence.split("·")[0]}</span>
                    )}
                </p>
                <p className="mt-1 text-sm text-zinc-500">
                    {plan.cadence.startsWith("/") ? plan.cadence.split("·")[1]?.trim() : plan.cadence}
                </p>
                <PlanFeatures features={plan.features} checkColor={checkColor} />
                <Link
                    to="/signup"
                    search={{ plan: plan.tier }}
                    className="group mt-8 flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-3 text-[15px] font-medium text-zinc-100 transition-colors duration-500 ease-silk hover:bg-white/[0.08]"
                >
                    {plan.cta}
                </Link>
            </div>
        </div>
    );
}

function PlanFeatures({ features, checkColor, bright }: { features: string[]; checkColor: string; bright?: boolean }) {
    return (
        <ul className={`mt-7 flex-1 space-y-3 text-sm ${bright ? "text-zinc-200" : "text-zinc-300"}`}>
            {features.map((feature) => (
                <li key={feature} className="flex gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0" stroke={checkColor} strokeWidth={1.8} />
                    {feature}
                </li>
            ))}
        </ul>
    );
}
