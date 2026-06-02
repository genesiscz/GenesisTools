import type { TrustTierId } from "@shared/tier-policy";
import type { ComponentType, SVGProps } from "react";
import { TRUST_SECTION, TRUST_TIERS } from "@/content/copy";
import { Check, CheckCircle, Cloud, Lock, Shield, Wifi } from "./icons";

type IconCmp = ComponentType<SVGProps<SVGSVGElement>>;

interface TierVisual {
    icon: IconCmp;
    iconWrap: string;
    iconColor: string;
    noSeeColor: string;
    trustMax?: boolean;
}

const TIER_VISUALS: Record<TrustTierId, TierVisual> = {
    lan: {
        icon: Wifi,
        iconWrap: "bg-emerald-500/10 ring-emerald-400/20",
        iconColor: "text-emerald-300",
        noSeeColor: "text-emerald-300",
    },
    tailscale: {
        icon: Shield,
        iconWrap: "bg-emerald-500/10 ring-emerald-400/20",
        iconColor: "text-emerald-300",
        noSeeColor: "text-emerald-300",
        trustMax: true,
    },
    "cloudflared-self": {
        icon: Cloud,
        iconWrap: "bg-violet-500/10 ring-violet-400/20",
        iconColor: "text-violet-300",
        noSeeColor: "text-violet-300",
    },
    managed: {
        icon: Lock,
        iconWrap: "bg-zinc-500/10 ring-white/10",
        iconColor: "text-zinc-300",
        noSeeColor: "text-zinc-200",
    },
};

export function TrustStory() {
    return (
        <section id="trust" className="mx-auto max-w-7xl px-4 py-28 md:px-8 md:py-40">
            <div className="mx-auto max-w-3xl text-center">
                <span className="reveal mb-5 inline-block rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-emerald-300/90">
                    {TRUST_SECTION.eyebrow}
                </span>
                <h2
                    className="reveal font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-zinc-50 md:text-5xl"
                    style={{ transitionDelay: "60ms" }}
                >
                    {TRUST_SECTION.titlePre}
                    <span className="grad-text">{TRUST_SECTION.titleGrad}</span>
                    {TRUST_SECTION.titlePost}
                </h2>
                <p className="reveal mt-5 text-lg leading-relaxed text-zinc-400" style={{ transitionDelay: "120ms" }}>
                    {TRUST_SECTION.body}
                </p>
            </div>

            <div className="mt-16 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
                {TRUST_TIERS.map((tier, i) => {
                    const v = TIER_VISUALS[tier.id];
                    const Icon = v.icon;
                    const ringCls = v.trustMax ? "ring-emerald-400/20" : "ring-white/[0.06]";

                    return (
                        <div
                            key={tier.id}
                            className="reveal rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl transition-transform duration-700 ease-silk hover:-translate-y-1.5"
                            style={{ transitionDelay: `${i * 80}ms` }}
                        >
                            <div
                                className={`inset-hi relative flex h-full flex-col rounded-[calc(2rem-0.375rem)] bg-[#0a0b0d] p-6 ring-1 ${ringCls}`}
                            >
                                {v.trustMax && (
                                    <span className="absolute right-5 top-5 rounded-full bg-emerald-400/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-400/25">
                                        {tier.badge}
                                    </span>
                                )}
                                <span
                                    className={`mb-5 flex h-10 w-10 items-center justify-center rounded-xl ring-1 ${v.iconWrap}`}
                                >
                                    <Icon className={`h-5 w-5 ${v.iconColor}`} />
                                </span>
                                <h3 className="font-display text-lg font-semibold text-zinc-100">{tier.label}</h3>
                                <p className={`mt-1 font-mono text-[11px] uppercase tracking-wider ${v.iconColor}/80`}>
                                    {tier.badge}
                                </p>
                                <p className="mt-3 flex-1 text-sm leading-relaxed text-zinc-400">{tier.claim}</p>
                                {tier.caveat && (
                                    <p className="mt-4 text-[11px] leading-snug text-zinc-500">{tier.caveat}</p>
                                )}
                                <p
                                    className={`mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium ${v.noSeeColor}`}
                                >
                                    <Check className="h-3.5 w-3.5" />
                                    {tier.noSeeLine}
                                </p>
                            </div>
                        </div>
                    );
                })}
            </div>

            <VerifyPromise />
        </section>
    );
}

function VerifyPromise() {
    return (
        <div
            className="reveal mt-8 rounded-[2.25rem] border border-white/10 bg-white/[0.03] p-2 backdrop-blur-2xl"
            style={{ transitionDelay: "120ms" }}
        >
            <div className="inset-hi grid items-center gap-8 rounded-[calc(2.25rem-0.5rem)] bg-gradient-to-br from-[#0a0b0d] to-[#0c0e10] p-8 ring-1 ring-white/[0.06] md:grid-cols-2 md:p-12">
                <div>
                    <h3 className="font-display text-3xl font-semibold leading-tight tracking-tight text-zinc-50">
                        {TRUST_SECTION.promiseTitle}
                    </h3>
                    <p className="mt-5 leading-relaxed text-zinc-400">{TRUST_SECTION.promiseBody}</p>
                    <ul className="mt-6 space-y-2.5 text-sm text-zinc-300">
                        {TRUST_SECTION.promiseBullets.map((bullet) => (
                            <li key={bullet} className="flex items-start gap-2.5">
                                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" stroke="#34d399" />
                                {bullet}
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="rounded-2xl border border-white/[0.07] bg-[#060708] p-1.5">
                    <div className="inset-hi overflow-hidden rounded-[calc(1rem-0.25rem)] bg-black/40 ring-1 ring-white/[0.05]">
                        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                            <span className="ml-2 font-mono text-[10px] text-zinc-500">verify-pairing</span>
                        </div>
                        <div className="space-y-1.5 px-5 py-5 font-mono text-[12px] leading-relaxed">
                            <p>
                                <span className="text-emerald-400">$</span>{" "}
                                <span className="text-zinc-300">devdash verify --safety-number</span>
                            </p>
                            <p className="text-zinc-500">
                                handshake … <span className="text-emerald-300">X25519 OK</span>
                            </p>
                            <p className="text-zinc-400">
                                phone <span className="text-violet-300">29 814 573</span>
                            </p>
                            <p className="text-zinc-400">
                                mac <span className="text-violet-300">29 814 573</span>
                            </p>
                            <p className="text-emerald-300">✓ numbers match — channel is end-to-end</p>
                            <p className="text-zinc-500">
                                relay sees: ciphertext only
                                <span className="caret ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-emerald-300" />
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
