import { HOW_SECTION } from "@/content/copy";

export function HowItWorks() {
    return (
        <section id="how" className="mx-auto max-w-7xl px-4 py-28 md:px-8 md:py-40">
            <div className="mx-auto max-w-3xl text-center">
                <span className="reveal mb-5 inline-block rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-emerald-300/90">
                    {HOW_SECTION.eyebrow}
                </span>
                <h2
                    className="reveal font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-zinc-50 md:text-5xl"
                    style={{ transitionDelay: "60ms" }}
                >
                    {HOW_SECTION.titlePre}
                    <span className="grad-text">{HOW_SECTION.titleGrad}</span>
                </h2>
            </div>

            <div className="mt-16 grid gap-5 md:grid-cols-3">
                {HOW_SECTION.steps.map((step, i) => (
                    <div
                        key={step.n}
                        className="reveal rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl"
                        style={{ transitionDelay: `${i * 100}ms` }}
                    >
                        <div className="inset-hi flex h-full flex-col rounded-[calc(2rem-0.375rem)] bg-[#0a0b0d] p-8 ring-1 ring-white/[0.06]">
                            <span
                                className={`font-mono text-sm ${i === 1 ? "text-violet-300/70" : "text-emerald-300/70"}`}
                            >
                                {step.n}
                            </span>
                            <h3 className="mt-4 font-display text-xl font-semibold text-zinc-50">{step.title}</h3>
                            <p className="mt-3 text-sm leading-relaxed text-zinc-400">{step.body}</p>

                            {step.n === "01" && step.code && (
                                <div className="mt-6 rounded-xl bg-black/40 px-4 py-3 font-mono text-[12px] text-zinc-300 ring-1 ring-white/[0.06]">
                                    <span className="text-emerald-400">$</span> {step.code}
                                </div>
                            )}
                            {step.n === "02" && (
                                <div className="mt-6 grid grid-cols-4 gap-1.5">
                                    <span className="rounded-lg bg-emerald-500/10 py-2 text-center font-mono text-[10px] text-emerald-300 ring-1 ring-emerald-400/20">
                                        LAN
                                    </span>
                                    <span className="rounded-lg bg-emerald-500/10 py-2 text-center font-mono text-[10px] text-emerald-300 ring-1 ring-emerald-400/20">
                                        TS
                                    </span>
                                    <span className="rounded-lg bg-violet-500/10 py-2 text-center font-mono text-[10px] text-violet-300 ring-1 ring-violet-400/20">
                                        CF
                                    </span>
                                    <span className="rounded-lg bg-white/[0.05] py-2 text-center font-mono text-[10px] text-zinc-300 ring-1 ring-white/10">
                                        Mgd
                                    </span>
                                </div>
                            )}
                            {step.n === "03" && (
                                <div className="mt-6 flex items-center gap-3 rounded-xl bg-black/40 px-4 py-3 ring-1 ring-emerald-400/20">
                                    <span className="live-dot h-2 w-2 rounded-full bg-emerald-400" />
                                    <span className="font-mono text-[12px] text-emerald-300">paired · end-to-end</span>
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
