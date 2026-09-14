import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, SectionTitle } from "@/components/dashboard/Card";
import { ArrowRight, Check } from "@/components/landing/icons";
import { getOverview } from "@/lib/dashboard/dashboard.functions";

export const Route = createFileRoute("/dashboard/")({
    loader: () => getOverview(),
    component: DashboardOverview,
});

function DashboardOverview() {
    const overview = Route.useLoaderData();
    const tier = overview.subscription.tier;
    const hasSubdomain = overview.subdomain !== null;
    const hasDevices = overview.deviceCount > 0;

    return (
        <div>
            <SectionTitle
                title="Overview"
                subtitle="Your managed setup at a glance. Finish the steps below to go remote."
            />

            <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                    <p className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">Plan</p>
                    <p
                        className="mt-2 font-display text-2xl font-semibold capitalize text-zinc-50"
                        data-testid="overview-plan"
                    >
                        {tier}
                    </p>
                    <Link
                        to="/dashboard/billing"
                        className="mt-3 inline-flex items-center gap-1 text-[12px] text-emerald-300 hover:text-emerald-200"
                    >
                        Manage plan <ArrowRight className="h-3 w-3" />
                    </Link>
                </Card>
                <Card>
                    <p className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">Devices paired</p>
                    <p className="mt-2 font-display text-2xl font-semibold text-zinc-50" data-testid="overview-device-count">
                        {overview.deviceCount}
                    </p>
                    <Link
                        to="/dashboard/devices"
                        className="mt-3 inline-flex items-center gap-1 text-[12px] text-emerald-300 hover:text-emerald-200"
                    >
                        View devices <ArrowRight className="h-3 w-3" />
                    </Link>
                </Card>
                <Card>
                    <p className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">Managed subdomain</p>
                    <p className="mt-2 font-mono text-sm text-zinc-200" data-testid="overview-subdomain">
                        {overview.subdomain?.hostname ?? "not claimed"}
                    </p>
                    <Link
                        to="/dashboard/setup"
                        className="mt-3 inline-flex items-center gap-1 text-[12px] text-emerald-300 hover:text-emerald-200"
                    >
                        {hasSubdomain ? "Setup wizard" : "Claim one"} <ArrowRight className="h-3 w-3" />
                    </Link>
                </Card>
            </div>

            <div className="mt-6">
                <Card>
                    <h2 className="font-display text-lg font-semibold text-zinc-100">Get remote in 4 steps</h2>
                    <ul className="mt-5 space-y-3" data-testid="overview-checklist">
                        <ChecklistItem done testId="overview-step-account" label="Account created" />
                        <ChecklistItem
                            done={tier !== "free"}
                            testId="overview-step-plan"
                            label="Choose a managed plan (Pro or Team)"
                        />
                        <ChecklistItem
                            done={hasSubdomain}
                            testId="overview-step-subdomain"
                            label="Claim a managed subdomain"
                        />
                        <ChecklistItem
                            done={hasDevices}
                            testId="overview-step-pair"
                            label="Pair your Mac agent + phone"
                        />
                    </ul>
                    <Link
                        to="/dashboard/setup"
                        className="group mt-7 inline-flex items-center gap-2.5 rounded-full bg-emerald-400 py-2.5 pl-5 pr-2 text-sm font-medium text-emerald-950 transition-transform duration-500 ease-silk active:scale-[0.98]"
                    >
                        Open the setup wizard
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-950/15 transition-transform duration-500 ease-silk group-hover:translate-x-1">
                            <ArrowRight className="h-3.5 w-3.5" />
                        </span>
                    </Link>
                </Card>
            </div>
        </div>
    );
}

function ChecklistItem({ done, label, testId }: { done: boolean; label: string; testId: string }) {
    return (
        <li className="flex items-center gap-3 text-sm" data-testid={testId} data-done={done ? "true" : "false"}>
            <span
                className={`flex h-5 w-5 items-center justify-center rounded-full ring-1 ${
                    done
                        ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30"
                        : "bg-white/[0.03] text-zinc-600 ring-white/10"
                }`}
            >
                {done ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            <span className={done ? "text-zinc-300" : "text-zinc-500"}>{label}</span>
        </li>
    );
}
