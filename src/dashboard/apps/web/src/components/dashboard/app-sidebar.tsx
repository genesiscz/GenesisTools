import { Link, useLocation } from "@tanstack/react-router";
import { AppSidebar as SharedAppSidebar, type SidebarNavGroup } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import {
    BarChart3,
    Bookmark,
    Brain,
    CalendarDays,
    Compass,
    LayoutDashboard,
    ListTodo,
    MessageSquare,
    ParkingCircle,
    Scale,
    Settings,
    StickyNote,
    Target,
    Timer,
    User,
} from "lucide-react";

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

export function AppSidebar() {
    const location = useLocation();
    const { user, signOut } = useAuth();

    const navGroups: SidebarNavGroup[] = [
        { label: "Main", theme: "primary", items: mainNavItems },
        { label: "Assistant", theme: "purple", items: assistantNavItems },
        { label: "Apps", theme: "accent", items: appsNavItems },
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
