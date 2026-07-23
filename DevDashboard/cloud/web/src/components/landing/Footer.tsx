import { Link } from "@tanstack/react-router";
import { FOOTER } from "@/content/copy";
import { ArrowRight, LogoMark } from "./icons";

export function Footer() {
    return (
        <footer className="mx-auto max-w-7xl px-4 pb-16 md:px-8">
            <div className="reveal rounded-[2.5rem] border border-white/10 bg-white/[0.03] p-2 backdrop-blur-2xl">
                <div className="inset-hi relative overflow-hidden rounded-[calc(2.5rem-0.5rem)] bg-gradient-to-br from-[#0a0b0d] via-[#0a0e0d] to-[#0b0a10] px-8 py-16 text-center ring-1 ring-white/[0.06] md:px-16 md:py-24">
                    <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[36rem] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[100px]" />
                    <span className="relative mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-emerald-300/90">
                        <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" /> {FOOTER.eyebrow}
                    </span>
                    <h2 className="relative mx-auto max-w-2xl font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-zinc-50 md:text-5xl">
                        {FOOTER.title}
                    </h2>
                    <p className="relative mx-auto mt-5 max-w-xl text-lg text-zinc-400">{FOOTER.body}</p>
                    <div className="relative mx-auto mt-10 flex max-w-md flex-col items-center gap-3 sm:flex-row">
                        <Link
                            to="/signup"
                            className="group flex w-full shrink-0 items-center justify-center gap-2.5 rounded-full bg-zinc-100 py-3 pl-5 pr-2 text-[15px] font-medium text-zinc-900 transition-transform duration-500 ease-silk active:scale-[0.98] sm:w-auto"
                        >
                            {FOOTER.cta}
                            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900/10 transition-transform duration-500 ease-silk group-hover:translate-x-1 group-hover:-translate-y-px">
                                <ArrowRight className="h-4 w-4" />
                            </span>
                        </Link>
                    </div>
                    <p className="relative mt-4 font-mono text-[11px] text-zinc-600">{FOOTER.finePrint}</p>
                </div>
            </div>

            <div className="mt-10 flex flex-col items-center justify-between gap-6 border-t border-white/[0.06] pt-8 text-sm text-zinc-500 md:flex-row">
                <div className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400/20 to-violet-500/20 ring-1 ring-white/10">
                        <LogoMark className="h-3.5 w-3.5 text-emerald-300" />
                    </span>
                    <span className="font-display font-semibold text-zinc-300">DevDashboard</span>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                    {FOOTER.links.map((label) => (
                        <a
                            key={label}
                            href={`#${label.toLowerCase().replace(/\s+/g, "-")}`}
                            className="transition-colors duration-500 ease-silk hover:text-zinc-200"
                        >
                            {label}
                        </a>
                    ))}
                </div>
                <p className="font-mono text-[11px] text-zinc-600">© 2026 DevDashboard</p>
            </div>
        </footer>
    );
}
