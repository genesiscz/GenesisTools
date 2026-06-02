import { FEATURES_SECTION } from "@/content/copy";
import { Bars, Bell, CheckSquare, Diamond, DockerWhale, Pulse, Terminal } from "./icons";

export function Features() {
    return (
        <section id="features" className="mx-auto max-w-7xl px-4 py-28 md:px-8 md:py-40">
            <div className="mx-auto max-w-3xl text-center">
                <span className="reveal mb-5 inline-block rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-violet-300/90">
                    {FEATURES_SECTION.eyebrow}
                </span>
                <h2
                    className="reveal font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-zinc-50 md:text-5xl"
                    style={{ transitionDelay: "60ms" }}
                >
                    {FEATURES_SECTION.titlePre}
                    <span className="grad-text">{FEATURES_SECTION.titleGrad}</span>
                    {FEATURES_SECTION.titlePost}
                </h2>
                <p className="reveal mt-5 text-lg leading-relaxed text-zinc-400" style={{ transitionDelay: "120ms" }}>
                    {FEATURES_SECTION.body}
                </p>
            </div>

            <div className="mt-16 grid auto-rows-[minmax(0,1fr)] grid-cols-1 gap-5 md:grid-cols-6">
                {/* Terminals — wide */}
                <div className="reveal md:col-span-4 md:row-span-2 rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl">
                    <div className="inset-hi flex h-full flex-col rounded-[calc(2rem-0.375rem)] bg-[#0a0b0d] p-7 ring-1 ring-white/[0.06] md:p-9">
                        <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/20">
                            <Terminal className="h-5 w-5 text-emerald-300" />
                        </span>
                        <h3 className="font-display text-2xl font-semibold text-zinc-50">Live interactive terminals</h3>
                        <p className="mt-3 max-w-md text-[15px] leading-relaxed text-zinc-400">
                            Full tmux & cmux sessions over ttyd — not screenshots. Type, scroll, switch panes, attach to
                            a running agent. Touch-tuned key bar for the keys a real terminal needs.
                        </p>
                        <div className="mt-7 grid flex-1 grid-cols-3 gap-2.5">
                            <MiniPane label="[0] claude" sub="editing…" subTone="text-emerald-300/90" />
                            <MiniPane label="[1] codex" sub="tests ✓" subTone="text-violet-300/90" />
                            <MiniPane label="[2] build" sub="+ done" subTone="text-emerald-300" highlight />
                        </div>
                    </div>
                </div>

                {/* Pulse — tall right */}
                <div
                    className="reveal md:col-span-2 md:row-span-2 rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl"
                    style={{ transitionDelay: "80ms" }}
                >
                    <div className="inset-hi flex h-full flex-col rounded-[calc(2rem-0.375rem)] bg-[#0a0b0d] p-7 ring-1 ring-white/[0.06]">
                        <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-violet-500/10 ring-1 ring-violet-400/20">
                            <Pulse className="h-5 w-5 text-violet-300" />
                        </span>
                        <h3 className="font-display text-2xl font-semibold text-zinc-50">System Pulse</h3>
                        <p className="mt-3 text-[15px] leading-relaxed text-zinc-400">
                            CPU, memory, swap, battery, disk and Wi-Fi as glowing live sparklines — Skia-fast, history
                            kept on-device.
                        </p>
                        <div className="mt-7 flex flex-1 items-end gap-1.5">
                            {[42, 64, 38, 80, 52, 70, 46, 88].map((h, i) => (
                                <span
                                    key={`${h}-${i}`}
                                    className={`bar w-full rounded-sm bg-gradient-to-t ${i % 3 === 2 ? "from-violet-500/20 to-violet-400/80" : "from-emerald-500/20 to-emerald-400/80"}`}
                                    style={{ height: `${h}%`, animationDelay: `${0.05 + i * 0.05}s` }}
                                />
                            ))}
                        </div>
                    </div>
                </div>

                {/* Agent alerts */}
                <div
                    className="reveal md:col-span-3 rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl"
                    style={{ transitionDelay: "120ms" }}
                >
                    <div className="inset-hi flex h-full flex-col rounded-[calc(2rem-0.375rem)] bg-[#0a0b0d] p-7 ring-1 ring-white/[0.06]">
                        <div className="flex items-center justify-between">
                            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 ring-1 ring-amber-400/20">
                                <Bell className="h-5 w-5 text-amber-300" />
                            </span>
                            <span className="rounded-full bg-amber-400/10 px-2.5 py-1 font-mono text-[10px] text-amber-300 ring-1 ring-amber-400/20">
                                needs input
                            </span>
                        </div>
                        <h3 className="mt-5 font-display text-xl font-semibold text-zinc-50">Agent-session alerts</h3>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                            Get pushed the moment Claude Code, Cursor or Codex pauses for a decision. Approve, redirect,
                            or jump into the live pane — without unlocking your laptop.
                        </p>
                    </div>
                </div>

                <SmallCard
                    title="QA & build signals"
                    body="Test runs, lint, type-checks and daemon jobs surface as searchable signals — red, green, and the diff that turned it."
                    icon={<CheckSquare className="h-5 w-5 text-emerald-300" />}
                    iconWrap="bg-emerald-500/10 ring-emerald-400/20"
                    span="md:col-span-3"
                    delay="160ms"
                />
                <SmallCard
                    title="Obsidian notes"
                    body="Your vault, read-through. Capture decisions on the move."
                    icon={<Diamond className="h-5 w-5 text-violet-300" />}
                    iconWrap="bg-violet-500/10 ring-violet-400/20"
                    span="md:col-span-2"
                    delay="120ms"
                />
                <SmallCard
                    title="Claude usage"
                    body="Token spend and session burn-down, at a glance."
                    icon={<Bars className="h-5 w-5 text-emerald-300" />}
                    iconWrap="bg-emerald-500/10 ring-emerald-400/20"
                    span="md:col-span-2"
                    delay="160ms"
                />
                <SmallCard
                    title="Docker containers"
                    body="Running, stopped, and logs — restart from your phone."
                    icon={<DockerWhale className="h-5 w-5 text-violet-300" />}
                    iconWrap="bg-violet-500/10 ring-violet-400/20"
                    span="md:col-span-2"
                    delay="200ms"
                />
            </div>
        </section>
    );
}

function MiniPane({
    label,
    sub,
    subTone,
    highlight,
}: {
    label: string;
    sub: string;
    subTone: string;
    highlight?: boolean;
}) {
    return (
        <div className={`rounded-xl bg-black/40 p-3 ring-1 ${highlight ? "ring-emerald-400/20" : "ring-white/[0.06]"}`}>
            <p className="font-mono text-[10px] text-zinc-500">{label}</p>
            <p className={`mt-1 font-mono text-[10px] ${subTone}`}>{sub}</p>
        </div>
    );
}

function SmallCard({
    title,
    body,
    icon,
    iconWrap,
    span,
    delay,
}: {
    title: string;
    body: string;
    icon: React.ReactNode;
    iconWrap: string;
    span: string;
    delay: string;
}) {
    return (
        <div
            className={`reveal ${span} rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl`}
            style={{ transitionDelay: delay }}
        >
            <div className="inset-hi flex h-full flex-col rounded-[calc(2rem-0.375rem)] bg-[#0a0b0d] p-7 ring-1 ring-white/[0.06]">
                <span className={`mb-5 flex h-11 w-11 items-center justify-center rounded-xl ring-1 ${iconWrap}`}>
                    {icon}
                </span>
                <h3 className="font-display text-xl font-semibold text-zinc-50">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{body}</p>
            </div>
        </div>
    );
}
