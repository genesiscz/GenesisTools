import { Card } from "@repo/ui/card";

const LINKS = [
    {
        title: "Dashboard",
        href: "/dashboard",
        description: "Your personal command center — timer, tasks, focus, planner.",
    },
    {
        title: "Timer & Focus",
        href: "/timer",
        description: "Precision time tracking with stopwatch, countdown, and Pomodoro modes.",
    },
    {
        title: "Assistant",
        href: "/assistant/tasks",
        description: "Tasks, decisions, context parking, and communication logs.",
    },
    {
        title: "Profile & Settings",
        href: "/profile",
        description: "Manage your NEXUS identity and account preferences.",
    },
];

export default function Page() {
    return (
        <main className="flex flex-col items-center justify-between min-h-screen p-24">
            <div className="z-10 w-full max-w-5xl font-mono text-sm">
                <h1 className="text-2xl font-bold">GenesisTools Dashboard Docs</h1>
                <p className="mt-2 text-neutral-500">
                    Documentation for the personal productivity dashboard.
                </p>
            </div>

            <div className="grid mb-32 text-center lg:max-w-5xl lg:w-full lg:mb-0 lg:grid-cols-4 lg:text-left">
                {LINKS.map(({ title, href, description }) => (
                    <Card href={href} key={title} title={title}>
                        {description}
                    </Card>
                ))}
            </div>
        </main>
    );
}
