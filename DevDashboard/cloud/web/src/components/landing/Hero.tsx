import { HERO } from "@/content/copy";
import { ArrowRight, ShieldCheck } from "./icons";

export function Hero() {
    return (
        <section className="mx-auto flex min-h-[100dvh] max-w-7xl flex-col items-center px-4 pt-36 pb-24 md:px-8 md:pt-44">
            <div className="reveal mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-emerald-300/90 backdrop-blur-xl">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {HERO.eyebrow}
            </div>

            <h1
                className="reveal max-w-4xl text-center font-display text-5xl font-semibold leading-[1.02] tracking-[-0.02em] text-zinc-50 sm:text-6xl md:text-7xl"
                style={{ transitionDelay: "60ms" }}
            >
                {HERO.titlePre}
                <span className="grad-text">{HERO.titleGrad}</span>
                {HERO.titlePost}
            </h1>

            <p
                className="reveal mt-7 max-w-2xl text-center text-lg leading-relaxed text-zinc-400 md:text-xl"
                style={{ transitionDelay: "140ms" }}
            >
                {HERO.body}
            </p>

            <div
                className="reveal mt-10 flex flex-col items-center gap-4 sm:flex-row"
                style={{ transitionDelay: "220ms" }}
            >
                <a
                    href="#how"
                    className="group flex items-center gap-3 rounded-full bg-emerald-400 py-3 pl-6 pr-2 text-[15px] font-medium text-emerald-950 transition-transform duration-500 ease-silk active:scale-[0.98]"
                >
                    {HERO.primaryCta}
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-950/15 transition-transform duration-500 ease-silk group-hover:translate-x-1 group-hover:-translate-y-px group-hover:scale-105">
                        <ArrowRight className="h-4 w-4" />
                    </span>
                </a>
                <a
                    href="#trust"
                    className="group flex items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.03] px-6 py-3 text-[15px] font-medium text-zinc-200 backdrop-blur-xl transition-colors duration-500 ease-silk hover:bg-white/[0.06]"
                >
                    <ShieldCheck className="h-4 w-4 text-emerald-300" />
                    {HERO.secondaryCta}
                </a>
            </div>

            <div
                className="reveal mt-20 grid w-full max-w-5xl gap-5 md:grid-cols-5"
                style={{ transitionDelay: "300ms" }}
            >
                <TerminalCard />
                <PulseCard />
            </div>

            <div
                className="reveal mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-600"
                style={{ transitionDelay: "380ms" }}
            >
                <span>LAN</span>
                <span className="text-zinc-700">·</span>
                <span>Tailscale / WireGuard</span>
                <span className="text-zinc-700">·</span>
                <span>Your Cloudflare tunnel</span>
                <span className="text-zinc-700">·</span>
                <span>Managed + E2E</span>
            </div>
        </section>
    );
}

function TerminalCard() {
    return (
        <div className="md:col-span-3 rounded-[2rem] border border-white/10 bg-white/[0.03] p-2 backdrop-blur-2xl shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
            <div className="inset-hi overflow-hidden rounded-[calc(2rem-0.5rem)] bg-[#0a0b0d] ring-1 ring-white/[0.06]">
                <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
                    <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                    <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
                    <span className="h-3 w-3 rounded-full bg-[#28c840]" />
                    <span className="ml-3 font-mono text-[11px] text-zinc-500">tmux · agent-session · mac.local</span>
                    <span className="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-400/20">
                        <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" /> live
                    </span>
                </div>
                <div className="space-y-1.5 px-5 py-5 font-mono text-[12.5px] leading-relaxed md:text-[13px]">
                    <p>
                        <span className="text-emerald-400">➜</span> <span className="text-violet-300">~/project</span>{" "}
                        <span className="text-zinc-500">tmux attach -t agents</span>
                    </p>
                    <p className="text-zinc-500">[0] claude-code [1] codex [2] pulse [3] build</p>
                    <p>
                        <span className="text-emerald-400">➜</span> <span className="text-violet-300">claude</span>{" "}
                        <span className="text-zinc-300">refactoring transport layer…</span>
                    </p>
                    <p className="text-zinc-400">
                        {"  "}
                        <span className="text-emerald-300">✓</span> extracted{" "}
                        <span className="text-zinc-200">Transport</span> interface · 4 tiers wired
                    </p>
                    <p className="text-amber-300/90">{"  "}⚠ awaiting input — approve schema migration? (y/n)</p>
                    <p className="text-zinc-500">
                        {"  "}
                        <span className="text-violet-300">push alert →</span> sent to iPhone · 0.4s
                    </p>
                    <p>
                        <span className="text-emerald-400">➜</span> <span className="text-violet-300">~/project</span>{" "}
                        <span className="text-zinc-300">y</span>
                        <span className="caret ml-0.5 inline-block h-3.5 w-2 translate-y-0.5 bg-emerald-300" />
                    </p>
                </div>
            </div>
        </div>
    );
}

function Sparkline({ id, color, line, delay }: { id: string; color: string; line: string; delay?: string }) {
    const area = `${line} L160,40 L0,40 Z`;

    return (
        <svg viewBox="0 0 160 40" className="h-10 w-full" preserveAspectRatio="none" aria-hidden="true">
            <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.35" />
                    <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
            </defs>
            <path d={area} fill={`url(#${id})`} />
            <path
                className="sparkline-path"
                style={delay ? { animationDelay: delay } : undefined}
                d={line}
                fill="none"
                stroke={color}
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function PulseCard() {
    return (
        <div className="md:col-span-2 rounded-[2rem] border border-white/10 bg-white/[0.03] p-2 backdrop-blur-2xl shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
            <div className="inset-hi h-full rounded-[calc(2rem-0.5rem)] bg-[#0a0b0d] p-5 ring-1 ring-white/[0.06]">
                <div className="mb-4 flex items-center justify-between">
                    <span className="font-display text-sm font-semibold tracking-tight text-zinc-200">Pulse</span>
                    <span className="font-mono text-[10px] text-zinc-500">last 60s</span>
                </div>

                <div className="mb-3">
                    <div className="mb-1 flex items-baseline justify-between">
                        <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">CPU</span>
                        <span className="font-mono text-xs text-emerald-300">38%</span>
                    </div>
                    <Sparkline
                        id="sg1"
                        color="#34d399"
                        line="M0,30 L16,26 L32,28 L48,18 L64,22 L80,12 L96,20 L112,9 L128,16 L144,7 L160,14"
                    />
                </div>

                <div className="mb-3">
                    <div className="mb-1 flex items-baseline justify-between">
                        <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">Memory</span>
                        <span className="font-mono text-xs text-violet-300">11.2 / 16 GB</span>
                    </div>
                    <Sparkline
                        id="sg2"
                        color="#a78bfa"
                        delay=".25s"
                        line="M0,24 L16,22 L32,23 L48,20 L64,21 L80,17 L96,18 L112,15 L128,16 L144,13 L160,14"
                    />
                </div>

                <div className="grid grid-cols-3 gap-2 pt-1">
                    <MiniStat label="Battery" value="92%" tone="text-emerald-300" />
                    <MiniStat label="Disk" value="412 GB" tone="text-zinc-200" />
                    <MiniStat label="Wi-Fi" value="−42 dB" tone="text-violet-300" />
                </div>
            </div>
        </div>
    );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: string }) {
    return (
        <div className="rounded-xl bg-white/[0.03] px-2.5 py-2 ring-1 ring-white/[0.06]">
            <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
            <p className={`font-mono text-sm ${tone}`}>{value}</p>
        </div>
    );
}
