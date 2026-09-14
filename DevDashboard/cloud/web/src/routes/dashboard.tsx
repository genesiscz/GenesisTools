import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { LogoMark } from "@/components/landing/icons";
import { getMe } from "@/lib/auth/auth.functions";
import { signOut } from "@/lib/auth/auth-client";

export const Route = createFileRoute("/dashboard")({
    beforeLoad: async () => {
        const user = await getMe();

        if (!user) {
            throw redirect({ to: "/signin" });
        }

        return { user };
    },
    loader: ({ context }) => ({ user: context.user }),
    component: DashboardLayout,
});

interface NavItem {
    to: "/dashboard" | "/dashboard/setup" | "/dashboard/devices" | "/dashboard/settings" | "/dashboard/billing";
    label: string;
    exact?: boolean;
}

const NAV: readonly NavItem[] = [
    { to: "/dashboard", label: "Overview", exact: true },
    { to: "/dashboard/setup", label: "Setup wizard" },
    { to: "/dashboard/devices", label: "Devices" },
    { to: "/dashboard/settings", label: "Settings" },
    { to: "/dashboard/billing", label: "Billing" },
];

function DashboardLayout() {
    const { user } = Route.useLoaderData();
    const navigate = useNavigate();
    const pathname = useRouterState({ select: (s) => s.location.pathname });

    async function onSignOut() {
        await signOut();
        await navigate({ to: "/signin" });
    }

    return (
        <div className="relative z-10 mx-auto flex min-h-[100dvh] max-w-6xl flex-col px-4 py-8 md:px-8">
            <header className="flex items-center justify-between gap-4 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 pl-5 backdrop-blur-2xl">
                <Link to="/" className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400/20 to-violet-500/20 ring-1 ring-white/10">
                        <LogoMark className="h-4 w-4 text-emerald-300" />
                    </span>
                    <span className="font-display text-[15px] font-semibold tracking-tight text-zinc-100">
                        DevDashboard
                    </span>
                </Link>
                <div className="flex items-center gap-3">
                    <span className="hidden font-mono text-[12px] text-zinc-500 sm:inline">{user.email}</span>
                    <button
                        type="button"
                        onClick={onSignOut}
                        className="rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-300 ring-1 ring-white/10 transition-colors duration-500 ease-silk hover:bg-white/[0.1]"
                    >
                        Sign out
                    </button>
                </div>
            </header>

            <div className="mt-8 flex flex-col gap-8 md:flex-row">
                <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
                    {NAV.map((item) => {
                        const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);

                        return (
                            <Link
                                key={item.to}
                                to={item.to}
                                className={`whitespace-nowrap rounded-xl px-3.5 py-2 text-sm transition-colors duration-500 ease-silk ${
                                    active
                                        ? "bg-white/[0.06] text-zinc-100 ring-1 ring-white/10"
                                        : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                                }`}
                            >
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>

                <main className="min-w-0 flex-1">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
