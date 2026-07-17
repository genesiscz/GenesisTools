import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@app/utils/ui/components/dialog";
import { Input } from "@app/utils/ui/components/input";
import { computeCreditBuckets } from "@app/utils/ui/components/youtube/billing-ui";
import { formatDiamonds } from "@app/utils/ui/components/youtube/diamond";
import { formatLedgerReason } from "@app/utils/ui/components/youtube/ledger-copy";
import { formatRelativeTime } from "@app/utils/ui/components/youtube/time";
import {
    useAdminAiCalls,
    useAdminJobs,
    useAdminRevenue,
    useAdminUser,
    useAdminUsers,
    useAdminWebhookLogs,
} from "@ext/api.hooks";
import { ArrowLeft, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";

type AdminTab = "users" | "ai-calls" | "webhooks" | "jobs" | "revenue";

const TABS: Array<{ id: AdminTab; label: string }> = [
    { id: "users", label: "Users" },
    { id: "ai-calls", label: "AI calls" },
    { id: "webhooks", label: "Webhooks" },
    { id: "jobs", label: "Jobs" },
    { id: "revenue", label: "Revenue" },
];

function formatUsd(usd: number): string {
    return `$${usd.toFixed(2)}`;
}

const labelCls = "font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground";
const cellHead = "px-2 py-1.5 text-left font-medium text-muted-foreground";
const cell = "px-2 py-1.5 align-top";

/**
 * 16:9 admin panel (spec §5) — a large dialog for admin/dev roles only (the
 * trigger is role-gated by the caller, endpoints are gated server-side too).
 * Tabs: Users (search/filter → row drill-in), AI calls, Webhook logs, Jobs +
 * queue, Revenue. Each tab's query is enabled only while its tab is active so
 * opening the panel doesn't fan out five requests at once.
 */
export function AdminPanelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [tab, setTab] = useState<AdminTab>("users");
    const [selectedUserId, setSelectedUserId] = useState<number | null>(null);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton
                className="flex aspect-[16/9] max-h-[85vh] w-[96vw] max-w-[min(96vw,960px)] flex-col gap-0 overflow-hidden bg-card p-0"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <div className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
                    <DialogTitle className="text-base">Admin</DialogTitle>
                    <DialogDescription className="sr-only">
                        Operational dashboard for admins and devs.
                    </DialogDescription>
                    <div className="ml-2 flex gap-1 overflow-x-auto rounded-lg border border-white/8 bg-black/20 p-1">
                        {TABS.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => {
                                    setTab(item.id);
                                    setSelectedUserId(null);
                                }}
                                className={`h-7 shrink-0 rounded-md px-3 text-xs font-medium transition-colors ${
                                    tab === item.id
                                        ? "bg-white/10 text-foreground"
                                        : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {tab === "users" ? (
                        selectedUserId !== null ? (
                            <UserProfile id={selectedUserId} onBack={() => setSelectedUserId(null)} />
                        ) : (
                            <UsersTab active={open} onSelectUser={setSelectedUserId} />
                        )
                    ) : tab === "ai-calls" ? (
                        <AiCallsTab active={open} />
                    ) : tab === "webhooks" ? (
                        <WebhooksTab active={open} />
                    ) : tab === "jobs" ? (
                        <JobsTab active={open} />
                    ) : (
                        <RevenueTab active={open} />
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Pending() {
    return (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
        </div>
    );
}

function ErrorNote({ error }: { error: unknown }) {
    return (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
            <p className="break-words text-destructive/90">
                {error instanceof Error ? error.message : "Something went wrong."}
            </p>
        </div>
    );
}

function UsersTab({ active, onSelectUser }: { active: boolean; onSelectUser: (id: number) => void }) {
    const [q, setQ] = useState("");
    const [sort, setSort] = useState<"created" | "revenue" | "net" | "credits">("created");
    const users = useAdminUsers({ q: q.trim() || undefined, sort, enabled: active });

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search email…"
                    className="h-8 w-52 text-sm"
                    aria-label="Search users by email"
                />
                <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as typeof sort)}
                    aria-label="Sort users"
                    className="h-8 rounded-md border border-white/8 bg-black/20 px-2 text-xs text-foreground"
                >
                    <option value="created">Newest</option>
                    <option value="revenue">Revenue</option>
                    <option value="net">Net</option>
                    <option value="credits">Diamonds</option>
                </select>
                {users.data ? <span className="text-xs text-muted-foreground">{users.data.total} users</span> : null}
            </div>

            {users.isPending ? (
                <Pending />
            ) : users.isError ? (
                <ErrorNote error={users.error} />
            ) : (
                <div className="overflow-x-auto rounded-lg border border-white/8">
                    <table className="w-full text-xs">
                        <thead className="border-b border-white/8 bg-black/20">
                            <tr>
                                <th className={cellHead}>Email</th>
                                <th className={cellHead}>Role</th>
                                <th className={`${cellHead} text-right`}>Diamonds</th>
                                <th className={`${cellHead} text-right`}>Revenue</th>
                                <th className={`${cellHead} text-right`}>Cost</th>
                                <th className={`${cellHead} text-right`}>Net</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.data.users.map((user) => (
                                <tr
                                    key={user.id}
                                    tabIndex={0}
                                    onClick={() => onSelectUser(user.id)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            onSelectUser(user.id);
                                        }
                                    }}
                                    className="cursor-pointer border-b border-white/5 outline-none last:border-0 hover:bg-white/5 focus-visible:bg-white/5"
                                >
                                    <td className={`${cell} max-w-[220px] truncate text-foreground/95`}>
                                        {user.email}
                                    </td>
                                    <td className={cell}>
                                        {user.role === "user" ? (
                                            <span className="text-muted-foreground">user</span>
                                        ) : (
                                            <span className="text-primary">{user.role}</span>
                                        )}
                                    </td>
                                    <td className={`${cell} text-right tabular-nums`}>
                                        {formatDiamonds(user.credits)}
                                    </td>
                                    <td className={`${cell} text-right tabular-nums`}>
                                        {formatUsd(user.revenueCents / 100)}
                                    </td>
                                    <td className={`${cell} text-right tabular-nums text-muted-foreground`}>
                                        {formatUsd(user.aiCostUsd)}
                                    </td>
                                    <td
                                        className={`${cell} text-right font-medium tabular-nums ${
                                            user.netUsd >= 0 ? "text-primary" : "text-destructive"
                                        }`}
                                    >
                                        {formatUsd(user.netUsd)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function UserProfile({ id, onBack }: { id: number; onBack: () => void }) {
    const profile = useAdminUser(id);

    return (
        <div className="space-y-4">
            <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
                <ArrowLeft className="size-4" /> Back to users
            </button>

            {profile.isPending ? (
                <Pending />
            ) : profile.isError ? (
                <ErrorNote error={profile.error} />
            ) : profile.data ? (
                (() => {
                    const data = profile.data;
                    const buckets = computeCreditBuckets({
                        credits: data.user.credits,
                        subscription: data.billing.subscription,
                    });

                    return (
                        <div className="space-y-4">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                <p className="text-sm font-semibold text-foreground/95">{data.user.email}</p>
                                <span className="text-xs text-primary">{data.role}</span>
                                <span className="text-xs text-muted-foreground">
                                    joined {formatRelativeTime(data.user.createdAt)}
                                </span>
                            </div>

                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                <Stat label="Diamonds" value={formatDiamonds(data.user.credits)} />
                                <Stat label="Revenue" value={formatUsd(data.totals.revenueCents / 100)} />
                                <Stat label="AI cost" value={formatUsd(data.totals.aiCostUsd)} />
                                <Stat
                                    label="Net"
                                    value={formatUsd(data.totals.netUsd)}
                                    tone={data.totals.netUsd >= 0 ? "good" : "bad"}
                                />
                            </div>

                            <Section title="Billing">
                                <p className="text-sm text-muted-foreground">
                                    {data.billing.subscription
                                        ? `${data.billing.subscription.planId} · ${data.billing.subscription.status} · ${formatDiamonds(
                                              buckets.allowanceRemaining
                                          )}/${formatDiamonds(buckets.allowance)} allowance`
                                        : "No subscription"}
                                    {data.billing.lowBalance ? " · low balance" : ""}
                                </p>
                            </Section>

                            <Section title={`Payments (${data.payments.length})`}>
                                {data.payments.length === 0 ? (
                                    <Empty />
                                ) : (
                                    <ul className="space-y-1">
                                        {data.payments.slice(0, 10).map((payment) => (
                                            <li
                                                key={payment.id}
                                                className="flex items-center justify-between gap-3 text-sm"
                                            >
                                                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                                    {payment.kind} · {payment.status}
                                                    {payment.packId ? ` · ${payment.packId}` : ""}
                                                    {payment.planId ? ` · ${payment.planId}` : ""}
                                                </span>
                                                <span className="shrink-0 tabular-nums text-foreground/90">
                                                    {payment.amountCents != null
                                                        ? formatUsd(payment.amountCents / 100)
                                                        : "—"}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </Section>

                            <Section title="Referral">
                                <p className="text-sm text-muted-foreground">
                                    {data.referral.code ? `Code ${data.referral.code}` : "No code"} ·{" "}
                                    {data.referral.referees.length} invited · +
                                    {formatDiamonds(data.referral.totalEarned)} earned
                                    {data.referral.referredBy ? ` · invited by ${data.referral.referredBy.email}` : ""}
                                </p>
                            </Section>

                            <Section title={`Recent ledger (${data.ledger.length})`}>
                                {data.ledger.length === 0 ? (
                                    <Empty />
                                ) : (
                                    <ul className="space-y-1">
                                        {data.ledger.slice(0, 12).map((row) => (
                                            <li
                                                key={row.id}
                                                className="flex items-center justify-between gap-3 text-sm"
                                            >
                                                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                                    {formatLedgerReason(row.reason).label}
                                                    {row.context ? ` · ${row.context}` : ""}
                                                </span>
                                                <span
                                                    className={`shrink-0 tabular-nums ${
                                                        row.delta < 0 ? "text-foreground/90" : "text-primary"
                                                    }`}
                                                >
                                                    {row.delta < 0 ? "−" : "+"}
                                                    {formatDiamonds(Math.abs(row.delta))}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </Section>

                            <div className="grid gap-3 sm:grid-cols-2">
                                <Section title={`Watched (${data.activity.watched.length})`}>
                                    {data.activity.watched.length === 0 ? (
                                        <Empty />
                                    ) : (
                                        <ul className="space-y-1">
                                            {data.activity.watched.slice(0, 8).map((watch) => (
                                                <li key={watch.id} className="truncate text-sm text-muted-foreground">
                                                    {watch.videoId} · {formatRelativeTime(watch.createdAt)}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </Section>
                                <Section title={`Jobs (${data.jobs.length})`}>
                                    {data.jobs.length === 0 ? (
                                        <Empty />
                                    ) : (
                                        <ul className="space-y-1">
                                            {data.jobs.slice(0, 8).map((job) => (
                                                <li
                                                    key={job.id}
                                                    className="flex items-center justify-between gap-2 text-sm"
                                                >
                                                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                                        #{job.id} · {job.target}
                                                    </span>
                                                    <span className="shrink-0 text-xs text-foreground/80">
                                                        {job.status}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </Section>
                            </div>
                        </div>
                    );
                })()
            ) : null}
        </div>
    );
}

function AiCallsTab({ active }: { active: boolean }) {
    const [provider, setProvider] = useState("");
    const [action, setAction] = useState("");
    const calls = useAdminAiCalls({
        provider: provider.trim() || undefined,
        action: action.trim() || undefined,
        enabled: active,
    });

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="provider"
                    className="h-8 w-32 text-sm"
                    aria-label="Filter by provider"
                />
                <Input
                    value={action}
                    onChange={(e) => setAction(e.target.value)}
                    placeholder="action"
                    className="h-8 w-32 text-sm"
                    aria-label="Filter by action"
                />
                {calls.data ? <span className="text-xs text-muted-foreground">{calls.data.total} calls</span> : null}
            </div>
            {calls.isPending ? (
                <Pending />
            ) : calls.isError ? (
                <ErrorNote error={calls.error} />
            ) : (
                <div className="overflow-x-auto rounded-lg border border-white/8">
                    <table className="w-full text-xs">
                        <thead className="border-b border-white/8 bg-black/20">
                            <tr>
                                <th className={cellHead}>Provider / model</th>
                                <th className={cellHead}>Action</th>
                                <th className={`${cellHead} text-right`}>Tokens</th>
                                <th className={`${cellHead} text-right`}>Cost</th>
                                <th className={`${cellHead} text-right`}>When</th>
                            </tr>
                        </thead>
                        <tbody>
                            {calls.data.aiCalls.map((call) => (
                                <tr key={call.id} className="border-b border-white/5 last:border-0">
                                    <td className={`${cell} text-foreground/90`}>
                                        {call.provider}/{call.model}
                                    </td>
                                    <td className={`${cell} text-muted-foreground`}>{call.action}</td>
                                    <td className={`${cell} text-right tabular-nums text-muted-foreground`}>
                                        {call.inputTokens}/{call.outputTokens}
                                    </td>
                                    <td className={`${cell} text-right tabular-nums`}>
                                        {call.costUsd != null ? formatUsd(call.costUsd) : "—"}
                                    </td>
                                    <td className={`${cell} text-right text-muted-foreground`}>
                                        {formatRelativeTime(call.createdAt)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function WebhooksTab({ active }: { active: boolean }) {
    const [outcome, setOutcome] = useState("");
    const logs = useAdminWebhookLogs({ outcome: outcome || undefined, enabled: active });

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <select
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                    aria-label="Filter webhook outcome"
                    className="h-8 rounded-md border border-white/8 bg-black/20 px-2 text-xs text-foreground"
                >
                    <option value="">All outcomes</option>
                    <option value="processed">processed</option>
                    <option value="skipped">skipped</option>
                    <option value="duplicate">duplicate</option>
                    <option value="error">error</option>
                </select>
                {logs.data ? <span className="text-xs text-muted-foreground">{logs.data.total} events</span> : null}
            </div>
            {logs.isPending ? (
                <Pending />
            ) : logs.isError ? (
                <ErrorNote error={logs.error} />
            ) : (
                <div className="overflow-x-auto rounded-lg border border-white/8">
                    <table className="w-full text-xs">
                        <thead className="border-b border-white/8 bg-black/20">
                            <tr>
                                <th className={cellHead}>Type</th>
                                <th className={cellHead}>Outcome</th>
                                <th className={cellHead}>Detail</th>
                                <th className={`${cellHead} text-right`}>When</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.data.webhookLogs.map((log) => (
                                <tr key={log.id} className="border-b border-white/5 last:border-0">
                                    <td className={`${cell} text-foreground/90`}>{log.type}</td>
                                    <td className={cell}>
                                        <span className={log.outcome === "error" ? "text-destructive" : "text-primary"}>
                                            {log.outcome}
                                        </span>
                                    </td>
                                    <td className={`${cell} max-w-[280px] truncate text-muted-foreground`}>
                                        {log.detail ?? "—"}
                                    </td>
                                    <td className={`${cell} text-right text-muted-foreground`}>
                                        {formatRelativeTime(log.createdAt)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function JobsTab({ active }: { active: boolean }) {
    const [status, setStatus] = useState("");
    const jobs = useAdminJobs({ status: status || undefined, enabled: active });

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    aria-label="Filter job status"
                    className="h-8 rounded-md border border-white/8 bg-black/20 px-2 text-xs text-foreground"
                >
                    <option value="">All statuses</option>
                    <option value="pending">pending</option>
                    <option value="running">running</option>
                    <option value="completed">completed</option>
                    <option value="failed">failed</option>
                    <option value="cancelled">cancelled</option>
                </select>
                {jobs.data ? (
                    <span className="text-xs text-muted-foreground">
                        {jobs.data.queue.queued} queued · {jobs.data.queue.running} running
                    </span>
                ) : null}
            </div>
            {jobs.isPending ? (
                <Pending />
            ) : jobs.isError ? (
                <ErrorNote error={jobs.error} />
            ) : (
                <div className="overflow-x-auto rounded-lg border border-white/8">
                    <table className="w-full text-xs">
                        <thead className="border-b border-white/8 bg-black/20">
                            <tr>
                                <th className={cellHead}>#</th>
                                <th className={cellHead}>Target</th>
                                <th className={cellHead}>Stages</th>
                                <th className={cellHead}>Status</th>
                                <th className={`${cellHead} text-right`}>When</th>
                            </tr>
                        </thead>
                        <tbody>
                            {jobs.data.jobs.map((job) => (
                                <tr key={job.id} className="border-b border-white/5 last:border-0">
                                    <td className={`${cell} tabular-nums text-muted-foreground`}>{job.id}</td>
                                    <td className={`${cell} max-w-[180px] truncate text-foreground/90`}>
                                        {job.target}
                                    </td>
                                    <td className={`${cell} text-muted-foreground`}>{(job.stages ?? []).join(", ")}</td>
                                    <td className={cell}>
                                        <span
                                            className={
                                                job.status === "failed"
                                                    ? "text-destructive"
                                                    : job.status === "completed"
                                                      ? "text-primary"
                                                      : "text-muted-foreground"
                                            }
                                        >
                                            {job.status}
                                        </span>
                                    </td>
                                    <td className={`${cell} text-right text-muted-foreground`}>
                                        {formatRelativeTime(job.createdAt)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function RevenueTab({ active }: { active: boolean }) {
    const revenue = useAdminRevenue(active);

    if (revenue.isPending) {
        return <Pending />;
    }

    if (revenue.isError) {
        return <ErrorNote error={revenue.error} />;
    }

    if (!revenue.data) {
        return null;
    }

    const { totals, daily } = revenue.data;
    const maxRevenue = Math.max(1, ...daily.map((day) => day.revenueCents));

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Revenue" value={formatUsd(totals.revenueCents / 100)} />
                <Stat label="AI cost" value={formatUsd(totals.aiCostUsd)} />
                <Stat label="Payments" value={String(totals.paymentsCount)} />
                <Stat label="Active subs" value={String(totals.activeSubscriptions)} />
            </div>

            <div className="space-y-2">
                <p className={labelCls}>revenue · last 30 days</p>
                <div className="flex h-28 items-end gap-[3px]">
                    {daily.map((day) => (
                        <div
                            key={day.day}
                            title={`${day.day} · ${formatUsd(day.revenueCents / 100)}`}
                            className={`min-w-0 flex-1 rounded-sm ${day.revenueCents === 0 ? "bg-white/5" : "bg-primary/50"}`}
                            style={{ height: `${Math.max(4, (day.revenueCents / maxRevenue) * 100)}%` }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
    return (
        <div className="rounded-lg border border-white/8 bg-black/20 p-2.5">
            <p className={labelCls}>{label}</p>
            <p
                className={`mt-1 text-base font-semibold tabular-nums ${
                    tone === "good" ? "text-primary" : tone === "bad" ? "text-destructive" : "text-foreground"
                }`}
            >
                {value}
            </p>
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="space-y-1.5">
            <p className={labelCls}>{title}</p>
            {children}
        </div>
    );
}

function Empty() {
    return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
}
