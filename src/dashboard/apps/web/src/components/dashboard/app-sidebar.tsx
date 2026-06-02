import { Link, useLocation } from "@tanstack/react-router";
import { AppSidebar as SharedAppSidebar, type SidebarNavGroup } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import {
    Ban,
    BarChart3,
    Bookmark,
    BookOpen,
    Brain,
    CalendarDays,
    Compass,
    Goal,
    LayoutDashboard,
    ListTodo,
    MessageSquare,
    ParkingCircle,
    Repeat,
    Scale,
    Settings,
    Smile,
    StickyNote,
    Target,
    Timer,
    User,
    Wallet,
} from "lucide-react";
import { useFocusSession } from "@/routes/dashboard/-focus";

const mainNavItems = [
    {
        title: "Dashboard",
        url: "/dashboard",
        icon: LayoutDashboard,
    },
    {
        title: "Timer",
        url: "/timer",
        icon: Timer,
    },
];

const assistantNavItems = [
    {
        title: "Tasks",
        url: "/assistant/tasks",
        icon: ListTodo,
    },
    {
        title: "What's Next",
        url: "/assistant/next",
        icon: Compass,
    },
    {
        title: "Context Parking",
        url: "/assistant/parking",
        icon: ParkingCircle,
    },
    {
        title: "Decisions",
        url: "/assistant/decisions",
        icon: Scale,
    },
    {
        title: "Communication",
        url: "/assistant/communication",
        icon: MessageSquare,
    },
    {
        title: "Analytics",
        url: "/assistant/analytics",
        icon: BarChart3,
    },
    {
        title: "Blockers",
        url: "/assistant/blockers",
        icon: Ban,
    },
];

const appsNavItems = [
    {
        title: "AI Assistant",
        url: "/dashboard/ai",
        icon: Brain,
    },
    {
        title: "Focus Mode",
        url: "/dashboard/focus",
        icon: Target,
    },
    {
        title: "Quick Notes",
        url: "/dashboard/notes",
        icon: StickyNote,
    },
    {
        title: "Bookmarks",
        url: "/dashboard/bookmarks",
        icon: Bookmark,
    },
    {
        title: "Daily Planner",
        url: "/dashboard/planner",
        icon: CalendarDays,
    },
    {
        title: "Habits",
        url: "/dashboard/habits",
        icon: Repeat,
    },
    {
        title: "Goals & OKRs",
        url: "/dashboard/goals",
        icon: Goal,
    },
    {
        title: "Mood Journal",
        url: "/dashboard/mood",
        icon: Smile,
    },
    {
        title: "Expenses",
        url: "/dashboard/expenses",
        icon: Wallet,
    },
    {
        title: "Reading List",
        url: "/dashboard/reading",
        icon: BookOpen,
    },
];

const settingsNavItems = [
    {
        title: "Settings",
        url: "/settings",
        icon: Settings,
    },
    {
        title: "Profile",
        url: "/profile",
        icon: User,
    },
];

function formatMMSS(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function AppSidebar() {
    const location = useLocation();
    const { user, signOut } = useAuth();
    const focus = useFocusSession();

    const focusAccessory = focus.isRunning ? formatMMSS(focus.remainingMs) : undefined;

    const appsNavItemsWithBadge = appsNavItems.map((item) =>
        item.url === "/dashboard/focus" ? { ...item, accessoryLabel: focusAccessory } : item
    );

    const navGroups: SidebarNavGroup[] = [
        { label: "Main", theme: "primary", items: mainNavItems },
        { label: "Assistant", theme: "purple", items: assistantNavItems },
        { label: "Apps", theme: "accent", items: appsNavItemsWithBadge },
        { label: "System", theme: "neutral", items: settingsNavItems },
    ];

    const initials =
        user?.firstName && user?.lastName
            ? `${user.firstName[0]}${user.lastName[0]}`
            : (user?.email?.[0]?.toUpperCase() ?? "?");

    return (
        <SharedAppSidebar
            brand={{ initial: "N", name: "NEXUS", tagline: "Command Center" }}
            navGroups={navGroups}
            activePath={location.pathname}
            user={{
                name: user?.firstName ?? "User",
                email: user?.email,
                avatarUrl: user?.profilePictureUrl ?? undefined,
                initials,
            }}
            onSignOut={() => signOut()}
            LinkComponent={Link}
        />
    );
}
