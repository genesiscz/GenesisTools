import { formatDuration } from "@app/utils/format";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@app/utils/ui/components/sheet";
import { Skeleton } from "@app/utils/ui/components/skeleton";
import type { JobActivity } from "@app/youtube/lib/types";
import { useJobActivity } from "@app/yt/api.hooks";
import { parseSqliteDate } from "@app/yt/lib/format";
import { ChevronRight, Cog, Copy, DollarSign, Hash, Sparkles, Telescope, Workflow, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

interface KindStyle {
    label: string;
    icon: typeof Cog;
    badgeClass: string;
    accentClass: string;
}

const KIND_STYLES: Record<JobActivity["kind"], KindStyle> = {
    llm: {
        label: "LLM",
        icon: Sparkles,
        badgeClass: "border-amber-400/40 bg-amber-400/10 text-amber-100",
        accentClass: "from-amber-400/80 via-amber-300/60 to-amber-500/0",
    },
    embed: {
        label: "Embed",
        icon: Workflow,
        badgeClass: "border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-100",
        accentClass: "from-fuchsia-400/80 via-fuchsia-300/60 to-fuchsia-500/0",
    },
    transcribe: {
        label: "Transcribe",
        icon: Telescope,
        badgeClass: "border-cyan-400/40 bg-cyan-400/10 text-cyan-100",
        accentClass: "from-cyan-400/80 via-cyan-300/60 to-cyan-500/0",
    },
};

export function JobActivityDrawer({
    jobId,
    open,
    onOpenChange,
}: {
    jobId: number | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const activity = useJobActivity(open ? jobId : null);

    const totals = useMemo(() => {
        const rows = activity.data ?? [];
        const calls = rows.length;
        const tokensIn = rows.reduce((acc, row) => acc + (row.tokensIn ?? 0), 0);
        const tokensOut = rows.reduce((acc, row) => acc + (row.tokensOut ?? 0), 0);
        const costUsd = rows.reduce((acc, row) => acc + (row.costUsd ?? 0), 0);
        const lastSeen = rows.at(-1)?.completedAt ?? rows.at(-1)?.createdAt ?? null;
        return { calls, tokensIn, tokensOut, costUsd, lastSeen };
    }, [activity.data]);

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side="right"
                className="yt-scroll w-full overflow-y-auto border-l border-amber-400/15 bg-gradient-to-b from-[rgba(18,18,25,0.95)] via-[rgba(13,13,20,0.96)] to-[rgba(8,8,14,0.98)] backdrop-blur-2xl sm:max-w-2xl"
            >
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent"
                />
                <div
                    aria-hidden
                    className="pointer-events-none absolute -top-32 right-0 h-64 w-64 rounded-full bg-amber-500/[0.06] blur-3xl"
                />
                <div
                    aria-hidden
                    className="pointer-events-none absolute top-1/3 -left-20 h-72 w-72 rounded-full bg-cyan-500/[0.05] blur-3xl"
                />

                <div className="relative">
                    <SheetHeader className="space-y-3 px-1 pt-2">
                        <div className="flex items-center gap-2">
                            <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.85)]" />
                            <span className="font-mono text-[0.65rem] uppercase tracking-[0.32em] text-secondary">
                                Pipeline activity · live
                            </span>
                        </div>
                        <SheetTitle className="bg-gradient-to-r from-amber-200 via-amber-300 to-cyan-300 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
                            Activity for job <span className="font-mono">#{jobId ?? "?"}</span>
                        </SheetTitle>
                        <SheetDescription className="text-sm leading-6 text-muted-foreground">
                            Every LLM, embedding, and transcription call recorded against this pipeline job — with
                            prompt, response, token use, and cost.
                        </SheetDescription>
                    </SheetHeader>

                    <div className="mt-6 grid grid-cols-3 gap-3">
                        <SummaryCard
                            icon={<Hash className="size-4" />}
                            label="Calls"
                            value={String(totals.calls)}
                            valueClass="text-emerald-200"
                            ring="from-emerald-400/40 via-emerald-400/10 to-transparent"
                        />
                        <SummaryCard
                            icon={<Zap className="size-4" />}
                            label="Tokens"
                            value={`${formatTokens(totals.tokensIn)} → ${formatTokens(totals.tokensOut)}`}
                            valueClass="text-cyan-200"
                            ring="from-cyan-400/40 via-cyan-400/10 to-transparent"
                            hint="in / out"
                        />
                        <SummaryCard
                            icon={<DollarSign className="size-4" />}
                            label="Cost"
                            value={formatCost(totals.costUsd)}
                            valueClass="bg-gradient-to-r from-amber-200 to-amber-300 bg-clip-text text-transparent"
                            ring="from-amber-400/40 via-amber-400/10 to-transparent"
                        />
                    </div>

                    {activity.isPending ? (
                        <ActivitySkeleton />
                    ) : activity.data && activity.data.length > 0 ? (
                        <ul className="mt-6 space-y-3">
                            {activity.data.map((row) => (
                                <ActivityRow key={row.id} row={row} />
                            ))}
                        </ul>
                    ) : (
                        <ActivityEmpty />
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}

function SummaryCard({
    icon,
    label,
    value,
    valueClass,
    ring,
    hint,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    valueClass: string;
    ring: string;
    hint?: string;
}) {
    return (
        <div className="relative overflow-hidden rounded-2xl border border-primary/15 bg-black/40 p-4">
            <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${ring}`} />
            <div className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                <span className="text-secondary">{icon}</span>
                {label}
            </div>
            <div className={`mt-2 truncate font-mono text-lg font-bold tabular-nums ${valueClass}`}>{value}</div>
            {hint ? (
                <div className="mt-0.5 font-mono text-[0.6rem] uppercase tracking-[0.22em] text-muted-foreground/70">
                    {hint}
                </div>
            ) : null}
        </div>
    );
}

function ActivityRow({ row }: { row: JobActivity }) {
    const [expanded, setExpanded] = useState(false);
    const startedAt = parseSqliteDate(row.startedAt ?? row.createdAt);
    const kind = KIND_STYLES[row.kind];
    const KindIcon = kind.icon;

    return (
        <li className="group relative overflow-hidden rounded-2xl border border-primary/12 bg-black/35 transition duration-200 hover:-translate-y-0.5 hover:border-amber-400/35 hover:shadow-[0_18px_44px_rgba(0,0,0,0.45),0_0_28px_rgba(245,158,11,0.08)]">
            <div
                aria-hidden
                className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b ${kind.accentClass}`}
            />
            <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left"
            >
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-black/40 text-amber-200/85">
                    <KindIcon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.2em] ${kind.badgeClass}`}
                        >
                            {kind.label}
                        </span>
                        {row.stage ? (
                            <span className="font-mono text-[0.6rem] uppercase tracking-[0.22em] text-muted-foreground">
                                {row.stage}
                            </span>
                        ) : null}
                        <span className="truncate font-mono text-xs text-foreground/85">
                            <span className="text-secondary">{row.provider ?? "—"}</span>
                            <span className="mx-1 text-muted-foreground/60">·</span>
                            <span className="text-foreground/75">{row.model ?? "—"}</span>
                        </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.7rem] tabular-nums text-muted-foreground sm:grid-cols-4">
                        <Stat label="tokens">
                            <span className="text-cyan-200">{row.tokensIn ?? 0}</span>
                            <span className="mx-0.5 text-muted-foreground/60">/</span>
                            <span className="text-cyan-200/80">{row.tokensOut ?? 0}</span>
                        </Stat>
                        <Stat label="cost">
                            <span className="text-amber-200">{formatCost(row.costUsd ?? 0)}</span>
                        </Stat>
                        <Stat label="time">
                            {row.durationMs !== null ? formatDuration(row.durationMs, "ms", "hms") : "—"}
                        </Stat>
                        <Stat label="at">{startedAt ? startedAt.toLocaleTimeString() : "—"}</Stat>
                    </div>
                    {row.error ? (
                        <p className="mt-2 rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-1.5 font-mono text-[0.7rem] text-red-200">
                            error: {row.error}
                        </p>
                    ) : null}
                </div>
                <ChevronRight
                    className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-90 text-amber-300" : "group-hover:translate-x-0.5"}`}
                />
            </button>
            {expanded ? (
                <div className="space-y-3 border-t border-primary/10 px-4 py-3">
                    <PayloadBlock label="Prompt" value={row.prompt} tone="amber" />
                    <PayloadBlock label="Response" value={row.response} tone="cyan" />
                </div>
            ) : null}
        </li>
    );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <span className="flex items-baseline gap-1.5">
            <span className="text-[0.6rem] uppercase tracking-[0.22em] text-muted-foreground/65">{label}</span>
            <span>{children}</span>
        </span>
    );
}

function PayloadBlock({ label, value, tone }: { label: string; value: string | null; tone: "amber" | "cyan" }) {
    if (!value) {
        return null;
    }

    const labelClass = tone === "amber" ? "text-amber-300" : "text-cyan-300";

    return (
        <div className="overflow-hidden rounded-xl border border-border/40 bg-black/55">
            <div className="flex items-center justify-between border-b border-border/40 bg-black/30 px-3 py-1.5">
                <span className={`font-mono text-[0.6rem] uppercase tracking-[0.28em] ${labelClass}`}>{label}</span>
                <button
                    type="button"
                    onClick={() => {
                        navigator.clipboard.writeText(value);
                        toast.success(`${label} copied`);
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-black/40 px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.22em] text-muted-foreground transition hover:border-amber-400/40 hover:text-amber-200"
                >
                    <Copy className="size-3" /> copy
                </button>
            </div>
            <pre className="yt-scroll max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-foreground/85">
                {value}
            </pre>
        </div>
    );
}

function ActivitySkeleton() {
    return (
        <ul className="mt-6 space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
                <li key={index} className="rounded-2xl border border-primary/10 bg-black/30 p-4">
                    <Skeleton className="h-4 w-32 bg-primary/10" />
                    <div className="mt-3 grid grid-cols-4 gap-3">
                        <Skeleton className="h-3 bg-primary/10" />
                        <Skeleton className="h-3 bg-primary/10" />
                        <Skeleton className="h-3 bg-primary/10" />
                        <Skeleton className="h-3 bg-primary/10" />
                    </div>
                </li>
            ))}
        </ul>
    );
}

function ActivityEmpty() {
    return (
        <div className="mt-8 rounded-2xl border border-dashed border-primary/20 bg-black/20 p-8 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-amber-400/25 bg-amber-400/5 text-amber-300">
                <Cog className="size-5" />
            </div>
            <p className="mt-3 font-mono text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                no calls yet
            </p>
            <p className="mt-1 text-sm text-muted-foreground/80">
                Activity appears the moment a stage runs an LLM, embedder, or transcriber. Pipeline downloads and
                metadata fetches don't create activity rows.
            </p>
        </div>
    );
}

function formatTokens(value: number): string {
    if (value === 0) {
        return "0";
    }

    if (value < 1_000) {
        return String(value);
    }

    if (value < 1_000_000) {
        return `${(value / 1_000).toFixed(1)}k`;
    }

    return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number): string {
    if (usd === 0) {
        return "$0";
    }

    if (usd < 0.01) {
        return `$${usd.toFixed(4)}`;
    }

    return `$${usd.toFixed(2)}`;
}
